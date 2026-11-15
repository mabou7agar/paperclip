"""Validate data before any candidate module can be imported or executed."""
import hashlib
import io
import json
import pathlib
import re
import tarfile
from contracts import require, closed_json


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class Packet:
    def __init__(self, raw, expected_sha, profile, privileged=False):
        require(len(raw) <= 16 * 1024 * 1024 and sha(raw) == expected_sha, "packet_digest_mismatch")
        self.raw = raw
        self.files = {}
        names = set()
        total = 0
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r|gz") as archive:
            for count, member in enumerate(archive, 1):
                require(count <= 5000, "packet_member_limit")
                path = pathlib.PurePosixPath(member.name)
                require(not path.is_absolute() and ".." not in path.parts and str(path) not in names and
                        (member.isfile() or member.isdir()), "packet_path_invalid")
                require(str(path) not in ['', '.'] or member.isdir(), 'packet_path_invalid')
                names.add(str(path))
                total += member.size
                require(total <= 80 * 1024 * 1024 and member.size <= 32 * 1024 * 1024, "packet_size_limit")
                if member.isfile():
                    self.files[str(path)] = archive.extractfile(member).read()
        manifest = self.json("manifest.json")["files"]
        require(set(self.files) == set(manifest) | {"manifest.json", "SHA256SUMS"}, "packet_inventory_mismatch")
        for name, expected in manifest.items():
            require(len(self.files[name]) == expected["bytes"] and sha(self.files[name]) == expected["sha256"], "packet_file_digest_mismatch")
        candidates = [x for x in self.files if re.fullmatch(r"qualification-[a-z0-9-]+/trial\.json", x)]
        require(len(candidates) == 1, "packet_controller_ambiguous")
        self.directory = candidates[0].rsplit("/", 1)[0]
        self.trial = self.json(candidates[0])
        self.contract = self.json(self.directory + "/scope-contract.json")
        require(self.json(self.directory + "/candidate.json")["candidate"] == profile["candidate"], "packet_candidate_mismatch")
        dynamic = {'ownerRoot', 'driverReceiptPath', 'runtimeReceiptRoot', 'externalAuthorityPath',
                   'preexecutionAdmissionPath', 'caseArchivePath', 'caseRoot', 'authoritySchema',
                   'continuationId', 'operatorExecutionId'}
        require(set(self.trial) == set(profile['fixedTrialFields']) | dynamic, 'packet_unregistered_trial_fields')
        require(re.fullmatch(profile['executionIdPattern'], self.trial['operatorExecutionId']), 'packet_execution_id_invalid')
        for name, value in profile["fixedTrialFields"].items():
            require(self.trial.get(name) == value, "packet_trial_binding_mismatch")
        prefix = self.directory.removeprefix("qualification-")
        require(re.fullmatch(profile["continuationPattern"], self.trial["continuationId"]), "packet_continuation_invalid")
        require(self.trial["continuationId"].endswith("-" + prefix), "packet_continuation_mismatch")
        root = profile["authorityRoot"]
        expected = {
            "ownerRoot": root + "/qualification-" + self.trial["continuationId"],
            "externalAuthorityPath": root + "/" + prefix + "-verified-authority.json",
            "preexecutionAdmissionPath": root + "/" + prefix + "-preexecution-admission.json",
            "caseArchivePath": root + "/" + prefix + "-approved-cases.tar.gz",
            "driverReceiptPath": root + "/" + prefix + "-driver-attempt.json",
            "runtimeReceiptRoot": root + "/" + prefix + "-host-receipts",
            "caseRoot": profile["trialRoot"] + "/reviewed-" + prefix + "-cases",
        }
        for name, value in expected.items():
            require(self.trial.get(name) == value, "packet_runtime_path_refused")
        self.case_name = prefix + "-cases-v1.tar.gz"
        require(self.case_name in self.files and self.trial["continuationAttempt"] == self.trial["maxContinuationAttempts"] == 1,
                "packet_attempt_boundary_invalid")
        if privileged:
            # Only operator-registered Python templates may execute as root.
            # Prefix substitution changes bounded data identities, never free
            # code. No extension modules, bytecode, packages or import hooks.
            root_files = {name.removeprefix(self.directory + '/'): raw for name, raw in self.files.items()
                          if name.startswith(self.directory + '/')}
            require(all('/' not in name and re.fullmatch(r'[A-Za-z0-9_.-]+', name) and
                        not name.endswith(('.so', '.pyc', '.pyo', '.pth', '.zip')) for name in root_files),
                    'packet_privileged_import_inventory_invalid')
            code = {name.replace(prefix, '{key}'): sha(data.replace(prefix.encode(), b'{key}'))
                    for name, data in root_files.items() if name.endswith('.py')}
            require(code == profile['privilegedCodeDigests'], 'packet_privileged_code_not_registered')
        self.authority_schema = profile["authoritySchemaTemplate"].replace("{key}", prefix)
        require(self.trial["authoritySchema"] == self.contract["authoritySchema"] == self.authority_schema, "packet_authority_schema_invalid")

    def json(self, name):
        require(name in self.files, "packet_required_file_missing")
        return closed_json(self.files[name])

    def file_sha(self, name):
        require(name in self.files, "packet_required_file_missing")
        return sha(self.files[name])

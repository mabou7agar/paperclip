"""Closed job DTOs. Execution commands and filesystem roots are operator policy."""
import hashlib
import json
import re
import uuid

UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
SHA = re.compile(r"^[a-f0-9]{64}$")
KEY = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class Refusal(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(value, code):
    if not value:
        raise Refusal(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def closed_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refusal("nonfinite_json")))


def job_request(value):
    fields = {"taskId", "profile", "kind", "attachmentId", "packetSha256", "scopeIssueId",
              "scopeCommentId", "ackCommentId", "recipe", "companyId", "projectId", "agentId", "sourceRunId"}
    require(isinstance(value, dict) and set(value) == fields, "job_fields_invalid")
    require(all(isinstance(value[k], str) and UUID.fullmatch(value[k]) for k in
                ["taskId", "attachmentId", "companyId", "projectId", "agentId", "sourceRunId"]), "job_identity_invalid")
    require(isinstance(value["profile"], str) and KEY.fullmatch(value["profile"]), "job_profile_invalid")
    require(isinstance(value["packetSha256"], str) and SHA.fullmatch(value["packetSha256"]), "job_packet_invalid")
    require(value["kind"] in ["reviewed_controller", "control_checks"], "job_kind_invalid")
    if value["kind"] == "reviewed_controller":
        require(all(isinstance(value[k], str) and UUID.fullmatch(value[k]) for k in
                    ["scopeIssueId", "scopeCommentId", "ackCommentId"]) and value["recipe"] is None, "job_authority_invalid")
    else:
        require(all(value[k] is None for k in ["scopeIssueId", "scopeCommentId", "ackCommentId"]) and
                isinstance(value["recipe"], str) and
                re.fullmatch(r"[a-z][a-z0-9-]{0,95}-new\.py", value["recipe"]), "job_recipe_invalid")
    return dict(value)


def stable_input(value):
    # A tool response can be lost and retried in a later native task turn.
    # The original source run stays recorded but does not create another job.
    return {k: v for k, v in value.items() if k != "sourceRunId"}


def job_id(value):
    identity = {k: value[k] for k in ["companyId", "profile", "kind", "packetSha256", "scopeCommentId", "recipe"]}
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "paperclip.runner-job.v1:" + digest(identity)))


def closed_diagnostic(value, depth=0):
    """No arbitrary message/SQL/path/URL can enter a task through runner output.
    Keep explicit omissions; a missing field is never an invented pass."""
    require(depth <= 12, "diagnostic_depth")
    if value is None or type(value) in (bool, int):
        return value
    if isinstance(value, str):
        require(len(value) <= 160 and bool(re.fullmatch(r"[A-Za-z0-9_. -]+", value)), "diagnostic_string_not_closed")
        return value
    if isinstance(value, list):
        require(len(value) <= 256, "diagnostic_list_too_large")
        return [closed_diagnostic(x, depth + 1) for x in value]
    require(isinstance(value, dict) and len(value) <= 64, "diagnostic_object_invalid")
    result = {}
    for key, child in value.items():
        require(isinstance(key, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", key), "diagnostic_key_invalid")
        require(key.lower() not in {"message", "sql", "stack", "trace", "password", "token", "url", "path", "body", "stdout", "stderr"}, "diagnostic_private_field")
        result[key] = closed_diagnostic(child, depth + 1)
    require(len(canonical(result)) <= 32768, "diagnostic_too_large")
    return result

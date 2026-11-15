"""SSH carries only fixed operations and a validated UUID; no candidate command."""
import base64
import subprocess
import tempfile
import hashlib
from contracts import canonical, closed_json, require, UUID, SHA


class RemoteRepository:
    def call(self, profile, operation, identity=None, value=None):
        require(operation in ['stage', 'launch', 'inspect', 'cancel', 'readiness'], 'remote_operation_invalid')
        args = ['python3', '-I', '-B', profile['remoteInstall'] + '/remote_worker.py', '--' + operation]
        if identity:
            require(UUID.fullmatch(identity), 'remote_identity_invalid')
            args.append(identity)
        # Every argument is an operator constant or validated UUID. Data never
        # enters the remote shell command and credentials never enter argv.
        command = ' '.join(args)
        result = subprocess.run(['ssh', '-i', profile['sshIdentityFile'], '-o', 'IdentitiesOnly=yes',
                                 '-o', 'UserKnownHostsFile=' + profile['sshKnownHostsFile'],
                                 '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                                 profile['sshTarget'], command], input=canonical(value) if value else None,
                                capture_output=True, timeout=90 if operation == 'stage' else 30)
        require(result.returncode == 0 and len(result.stdout) <= 128 * 1024, 'remote_transport_unconfirmed')
        return closed_json(result.stdout)

    def stage(self, profile, identity, request, packet, admission):
        return self.call(profile, 'stage', value={'jobId': identity, 'request': request, 'profile': profile,
                         'packet': base64.b64encode(packet.raw).decode(), 'admission': admission})

    def readiness(self, profile, identity):
        return self.call(profile, 'readiness', identity)

    def launch(self, profile, identity):
        return self.call(profile, 'launch', identity)

    def inspect(self, profile, identity):
        return self.call(profile, 'inspect', identity)

    def cancel(self, profile, identity):
        return self.call(profile, 'cancel', identity)

    def artifact(self, profile, identity, sha):
        require(UUID.fullmatch(identity) and SHA.fullmatch(sha), 'artifact_identity_invalid')
        command = ' '.join(['python3', '-I', '-B', profile['remoteInstall'] + '/remote_worker.py', '--artifact', identity, sha])
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
            result = subprocess.run(['ssh', '-i', profile['sshIdentityFile'], '-o', 'IdentitiesOnly=yes',
                                 '-o', 'UserKnownHostsFile=' + profile['sshKnownHostsFile'],
                                 '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', profile['sshTarget'], command],
                                    stdout=output, stderr=error, timeout=90)
            require(result.returncode == 0 and 0 < output.tell() <= 32 * 1024 * 1024, 'artifact_transport_unconfirmed')
            output.seek(0)
            raw = output.read()
        require(hashlib.sha256(raw).hexdigest() == sha, 'artifact_transport_digest_mismatch')
        return raw

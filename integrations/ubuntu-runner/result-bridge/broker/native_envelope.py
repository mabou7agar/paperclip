"""Root-only signature authority. Public envelope bytes are verified by Node."""
import base64
import pathlib
import subprocess
import tempfile
from configuration import private_file
from contracts import canonical, require

DOMAIN = b'paperclip.ubuntu-runner-results.envelope.v1\n'
PLUGIN_KEY = 'paperclip.ubuntu-runner-results'


class EnvelopeSigner:
    def __init__(self, key_file):
        self.key_file = key_file
        private_file(key_file)

    def sign(self, value):
        raw = canonical(value)
        require(len(raw) <= 128 * 1024, 'native_envelope_too_large')
        # Ed25519 -rawin requires a seekable input with OpenSSL 3. Both files
        # are private even though the signed payload contains no credentials.
        with tempfile.TemporaryDirectory(prefix='runner-envelope-') as directory:
            data = pathlib.Path(directory) / 'payload'
            data.write_bytes(DOMAIN + raw); data.chmod(0o600)
            result = subprocess.run(['/usr/bin/openssl', 'pkeyutl', '-sign', '-rawin',
                '-inkey', str(private_file(self.key_file)), '-in', str(data)],
                capture_output=True, timeout=10)
        require(result.returncode == 0 and len(result.stdout) == 64, 'native_envelope_signing_unavailable')
        return {'payload': base64.b64encode(raw).decode(), 'signature': base64.b64encode(result.stdout).decode()}

"""Private local TLS issuer. Call only under the root-owned preview lease lock."""
import base64
import hashlib
import os
import re
import secrets
import shutil
import ssl
import subprocess
import tempfile
from pathlib import Path

from domains import DomainPolicy


class ProjectCertificates:
    def __init__(self, state, public, openssl='/usr/bin/openssl'):
        self.root, self.public, self.openssl = Path(state) / 'tls', Path(public), openssl
        self.authority = self.root / 'project-authority'
        self.leaves = self.root / 'project-leases'

    def run(self, *args):
        result = subprocess.run([self.openssl, *map(str, args)], capture_output=True, timeout=15)
        if result.returncode:
            # No key material or raw openssl input is returned to the caller.
            raise ValueError('Private project certificate operation failed.')
        return result.stdout

    def initialize(self):
        self.authority.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.leaves.mkdir(parents=True, exist_ok=True, mode=0o700)
        key, cert = self.authority / 'ca.key', self.authority / 'ca.crt'
        if key.is_file() != cert.is_file():
            raise ValueError('Incomplete persisted project CA; restore it without rotating client trust.')
        if not key.is_file() or not cert.is_file():
            with tempfile.TemporaryDirectory(dir=self.authority) as temporary:
                stage = Path(temporary)
                self.run('req', '-x509', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                         '-nodes', '-sha256', '-days', '3650', '-keyout', stage / 'ca.key', '-out', stage / 'ca.crt',
                         '-subj', '/CN=Paperclip Ubuntu project test CA',
                         '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
                         '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
                         '-addext', 'nameConstraints=critical,permitted;DNS:test,excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:0:0:0:0:0:0:0:0/0:0:0:0:0:0:0:0')
                for name, mode in [('ca.key', 0o600), ('ca.crt', 0o644)]:
                    os.chmod(stage / name, mode)
                    (stage / name).replace(self.authority / name)
        # Never silently rotate a persisted CA and invalidate existing client trust.
        self.run('x509', '-checkend', '2592000', '-noout', '-in', cert)
        self.public.mkdir(parents=True, exist_ok=True, mode=0o755)
        bundle = cert.read_bytes()
        target = self.public / 'ca-bundle.crt'
        temporary = target.with_suffix('.tmp')
        temporary.write_bytes(bundle)
        os.chmod(temporary, 0o644)
        temporary.replace(target)

    def remove_orphans(self):
        """Startup invalidates all listeners, so no old leaf can remain active."""
        for parent, pattern in [(self.leaves, '*'), (self.authority, 'tmp*')]:
            for path in parent.glob(pattern):
                if path.is_symlink() or path.is_file():
                    path.unlink()
                elif path.is_dir():
                    shutil.rmtree(path)

    def issue(self, key, hosts):
        if not re.fullmatch(r'[a-f0-9]{32}', key):
            raise ValueError('Invalid project certificate lease identity.')
        names = sorted(set(hosts))
        if not names or len(names) > 12:
            raise ValueError('Invalid project certificate names.')
        for host in names:
            DomainPolicy.hostname(host)
        directory = self.leaves / key
        if directory.exists():
            raise ValueError('A certificate lease cannot be issued twice.')
        with tempfile.TemporaryDirectory(dir=self.leaves) as temporary:
            stage = Path(temporary)
            extension = stage / 'leaf.ext'
            extension.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n'
                                 'extendedKeyUsage=serverAuth\nsubjectAltName=' + ','.join('DNS:' + n for n in names) + '\n')
            self.run('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
                     '-sha256', '-keyout', stage / 'leaf.key', '-out', stage / 'leaf.csr', '-subj', '/CN=Private project preview')
            self.run('x509', '-req', '-sha256', '-days', '397', '-in', stage / 'leaf.csr',
                     '-CA', self.authority / 'ca.crt', '-CAkey', self.authority / 'ca.key',
                     '-set_serial', '0x' + secrets.token_hex(16), '-extfile', extension, '-out', stage / 'leaf.crt')
            self.run('verify', '-CAfile', self.authority / 'ca.crt', stage / 'leaf.crt')
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(stage / 'leaf.crt', stage / 'leaf.key')
            public_key = self.run('x509', '-in', stage / 'leaf.crt', '-pubkey', '-noout')
            # Fixed stdin, no shell, and no private key leaves this process.
            der = subprocess.run([self.openssl, 'pkey', '-pubin', '-outform', 'der'], input=public_key,
                                 capture_output=True, timeout=15, check=True).stdout
            pin = base64.b64encode(hashlib.sha256(der).digest()).decode()
            directory.mkdir(mode=0o700)
            try:
                for name, mode in [('leaf.key', 0o600), ('leaf.crt', 0o644)]:
                    os.chmod(stage / name, mode)
                    (stage / name).replace(directory / name)
            except Exception:
                shutil.rmtree(directory)
                raise
        return {'certFile': str(directory / 'leaf.crt'), 'keyFile': str(directory / 'leaf.key')}, pin

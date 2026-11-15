"""Exercise release verification, modes and inventory on an isolated filesystem.

Current-user ownership stands in for root in this local suite; real Linux root
ownership and systemd activation are separate operator qualification gates.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runner_install', pathlib.Path(__file__).resolve().parents[1] / 'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name).resolve()
        self.source = self.root / 'source'; self.source.mkdir(mode=0o755)
        self.target = self.root / 'install'
        self.state = self.root / 'state'
        self.systemd = self.root / 'systemd'; self.systemd.mkdir(mode=0o755)
        def local_trusted(path):
            info = path.lstat()
            installer.require(not path.is_symlink() and (not info.st_mode & 0o022 or
                (stat.S_ISDIR(info.st_mode) and info.st_mode & stat.S_ISVTX)), 'Untrusted operator path')
            return info
        self.patches = [patch.object(installer, 'INSTALL_ROOT', self.target), patch.object(installer, 'STATE_ROOT', self.state),
            patch.object(installer, 'SYSTEMD_ROOT', self.systemd), patch.object(installer.os, 'getuid', return_value=0),
            patch.object(installer, 'trusted', side_effect=local_trusted)]
        for item in self.patches: item.start()

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.temp.cleanup()

    def release(self, files):
        manifest = {}
        for name, data in files.items():
            path = self.source / name; path.parent.mkdir(parents=True, mode=0o755, exist_ok=True)
            path.write_bytes(data); path.chmod(0o644)
            manifest[name] = hashlib.sha256(data).hexdigest()
        raw = json.dumps(manifest).encode()
        path = self.source / 'release-manifest.json'; path.write_bytes(raw); path.chmod(0o644)
        return hashlib.sha256(raw).hexdigest()

    def install(self, sha):
        with contextlib.redirect_stdout(io.StringIO()): installer.install(self.source, sha, 'broker')

    def test_umask_does_not_hide_plugin_and_only_prior_managed_code_is_removed(self):
        sha = self.release({'broker/old.py': b'old', 'plugin/worker.mjs': b'worker', 'paperclip-runner-results.service': b'unit'})
        previous = os.umask(0o077)
        try: self.install(sha)
        finally: os.umask(previous)
        self.assertEqual(stat.S_IMODE((self.target / 'plugin/worker.mjs').stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE((self.target / 'plugin').stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
        private = self.target / 'private-config.json'; private.write_text('operator configuration')
        sha = self.release({'broker/new.py': b'new', 'plugin/worker.mjs': b'worker2', 'paperclip-runner-results.service': b'unit2'})
        self.install(sha)
        self.assertFalse((self.target / 'old.py').exists())
        self.assertEqual(private.read_text(), 'operator configuration')
        self.assertEqual((self.target / 'new.py').read_bytes(), b'new')

    def test_changed_bytes_fail_before_creating_installation(self):
        sha = self.release({'broker/example.py': b'approved', 'paperclip-runner-results.service': b'unit'})
        (self.source / 'broker/example.py').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'Release bytes changed'): self.install(sha)
        self.assertFalse(self.target.exists())

    def test_writable_nested_source_directory_is_rejected(self):
        sha = self.release({'plugin/worker.mjs': b'approved', 'paperclip-runner-results.service': b'unit'})
        (self.source / 'plugin').chmod(0o777)
        with self.assertRaisesRegex(RuntimeError, 'Untrusted operator path'): self.install(sha)
        self.assertFalse(self.target.exists())

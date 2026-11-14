#!/usr/bin/env python3
"""Temporary-state boundary checks, never product tests or provider requests."""
import copy
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'preview'))
from configuration import load
from certificates import ProjectCertificates
from domains import DomainPolicy
from repository import LeaseRepository
from requests import AcquireRequest
from server import initialize
from service import PreviewService

PROJECT = '00000000-0000-4000-8000-000000000001'
OTHER = '00000000-0000-4000-8000-000000000002'
COMPANY = '00000000-0000-4000-8000-000000000003'


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='paperclip-domain-contract-')
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        self.hosts = self.root / 'hosts'
        self.hosts.write_text('127.0.0.1 localhost\n192.0.2.1 existing.test # other-integration\n')
        self.uid = os.getuid()
        self.config = {'state_root': str(self.root / 'state'), 'routes_root': str(self.root / 'routes'), 'state_mount': str(self.root), 'gateway_binary': '/usr/local/bin/traefik',
                       'hosts_file': str(self.hosts), 'tls_public': str(self.root / 'public'),
                       'guard_address': 'http://127.0.0.1:9848', 'port_min': 39000, 'port_max': 39999,
                       'lease_seconds': 60, 'starting_seconds': 30, 'domain_template': '{project}-agent.test',
                       'principals': {str(self.uid): {'company_id': COMPANY, 'workspace_roots': [str(self.workspace)]}},
                       'projects': {PROJECT: {'company_id': COMPANY, 'label': 'first'},
                                    OTHER: {'company_id': COMPANY, 'label': 'second'}}}
        Path(self.config['state_root']).mkdir()
        Path(self.config['routes_root']).mkdir()
        self.repo = LeaseRepository(self.config['state_root'], self.config['routes_root'], self.hosts)
        self.service = PreviewService(self.repo, self.config)
        self.service.issuer.initialize()

    def tearDown(self):
        self.temp.cleanup()

    def request(self, key='1' * 32, project=PROJECT):
        return {'id': key, 'projectId': project, 'workspace': str(self.workspace), 'aliases': ['academy']}

    def test_registered_identity_and_path_are_required(self):
        for change in [{'projectId': '00000000-0000-4000-8000-000000000009'},
                       {'workspace': str(self.root)}, {'aliases': ['app']}, {'aliases': ['a', 'a']},
                       {'aliases': ['*.test']}, {'companyId': COMPANY}]:
            with self.assertRaises(ValueError):
                AcquireRequest.parse({**self.request(), **change}, self.uid, self.config)
        other = copy.deepcopy(self.config)
        other['projects'][PROJECT]['company_id'] = '00000000-0000-4000-8000-000000000009'
        with self.assertRaises(ValueError):
            AcquireRequest.parse(self.request(), self.uid, other)
        self.assertEqual([], self.repo.all())

    def test_stable_collision_and_released_id_cannot_replay(self):
        lease = self.service.acquire(self.request(), self.uid)
        self.assertEqual('first-agent.test', lease['private_hosts']['app'])
        self.assertNotIn('certificate', lease)
        with self.assertRaises(ValueError):
            self.service.acquire(self.request('2' * 32), self.uid)
        with self.assertRaises(ValueError):
            self.service.release(lease['id'], self.uid + 1)
        self.service.release(lease['id'], self.uid)
        with self.assertRaises(ValueError):
            self.service.acquire(self.request(), self.uid)
        self.assertIn('existing.test', self.hosts.read_text())
        self.assertFalse((self.repo.root / 'tls/project-leases' / lease['id']).exists())

    def test_origin_ownership_survives_config_changes_and_release(self):
        lease = self.service.acquire(self.request(), self.uid)
        self.service.release(lease['id'], self.uid)
        altered = copy.deepcopy(self.config)
        altered['projects'][PROJECT]['label'] = 'old'
        altered['projects'][OTHER]['label'] = 'first'
        with self.assertRaises(ValueError):
            PreviewService(self.repo, altered).acquire(self.request('3' * 32, OTHER), self.uid)

    def test_activation_never_extends_deadline_and_expiry_withdraws_routes(self):
        lease = self.service.acquire(self.request(), self.uid)
        record = {'pid': 12345, 'start_identity': '456'}
        with patch('service.listener_identity', return_value={**record, 'uid': self.uid, 'listener_port': lease['port']}), patch('service.listener_matches', return_value=True):
            active = self.service.activate({'id': lease['id'], 'process': record}, self.uid)
            again = self.service.activate({'id': lease['id'], 'process': record}, self.uid)
        self.assertEqual(lease['expires_at'], active['expires_at'])
        self.assertEqual(active['expires_at'], again['expires_at'])
        self.assertNotIn('starting_expires_at', active)
        route = next(self.repo.routes.glob('paperclip-*.yml'))
        self.assertIn('first-agent.test', route.read_text())
        with patch('service.time.time', return_value=lease['expires_at'] + 1):
            self.service.collect()
        self.assertEqual([], self.repo.all())
        self.assertFalse(route.exists())

    def test_starting_grace_and_restart_touch_only_owned_state(self):
        other = self.repo.routes / 'unrelated.yml'
        other.write_text('{}')
        lease = self.service.acquire(self.request(), self.uid)
        with patch('service.time.time', return_value=lease['starting_expires_at'] + 1):
            self.service.collect()
        self.assertEqual([], self.repo.all())
        self.service.acquire(self.request('4' * 32), self.uid)
        initialize(self.config, self.repo)
        self.assertEqual([], self.repo.all())
        self.assertTrue(other.exists())
        self.assertIn('existing.test', self.hosts.read_text())

    def test_template_and_label_isolation(self):
        for template in ['{project}.{project}.test', '{project}.shared.test', '{workspace}.test', '{project:>4}.test', 'same.test']:
            with self.assertRaises(ValueError):
                DomainPolicy({**self.config, 'domain_template': template})
        duplicate = copy.deepcopy(self.config)
        duplicate['projects'][OTHER]['label'] = 'first'
        with self.assertRaises(ValueError):
            DomainPolicy(duplicate)
        concurrent = copy.deepcopy(self.config)
        concurrent['projects'][PROJECT]['concurrent'] = True
        policy = DomainPolicy(concurrent)
        self.assertNotEqual(policy.hosts(concurrent['projects'][PROJECT], 'a'*32, [])['app'],
                            policy.hosts(concurrent['projects'][PROJECT], 'b'*32, [])['app'])

    def test_exact_private_tls_and_key_permissions(self):
        # Match the target Ubuntu OpenSSL toolchain, including certificate
        # generation. macOS LibreSSL emits explicit EC parameters rejected by 3.5.
        config = {**self.config, 'state_root': str(self.root / 'crypto-state'),
                  'tls_public': str(self.root / 'crypto-public')}
        Path(config['state_root']).mkdir()
        repo = LeaseRepository(config['state_root'], self.repo.routes, self.hosts)
        service = PreviewService(repo, config)
        service.issuer.openssl = shutil.which('openssl')
        service.issuer.initialize()
        lease = service.acquire(self.request(), self.uid)
        authority = service.issuer.authority / 'ca.crt'
        key = service.issuer.leaves / lease['id'] / 'leaf.key'
        cert = key.with_name('leaf.crt')
        self.assertEqual(0o600, key.stat().st_mode & 0o777)
        self.assertEqual(0o700, key.parent.stat().st_mode & 0o777)
        verifier = service.issuer
        verifier.run('verify', '-CAfile', authority, '-verify_hostname', 'academy.first-agent.test', cert)
        with self.assertRaises(ValueError):
            verifier.run('verify', '-CAfile', authority, '-verify_hostname', 'other.first-agent.test', cert)
        text = verifier.run('x509', '-in', authority, '-noout', '-text').decode()
        self.assertIn('Permitted:', text)
        self.assertIn('Excluded:', text)
        self.assertIn('DNS:test', text)

    def test_configuration_rejects_remote_guard_and_writable_registry(self):
        path = self.root / 'config.json'
        path.write_text(json.dumps(self.config))
        path.chmod(0o600)
        self.assertEqual(self.config, load(path, self.uid))
        path.chmod(0o666)
        with self.assertRaises(ValueError):
            load(path, self.uid)
        path.chmod(0o600)
        path.write_text(json.dumps({**self.config, 'guard_address': 'http://192.0.2.1:9848'}))
        with self.assertRaises(ValueError):
            load(path, self.uid)


    def test_stopped_guard_blocks_admission_and_missing_roots_are_not_created(self):
        held = PreviewService(self.repo, self.config, admission_guard=lambda: False)
        with self.assertRaises(ValueError):
            held.acquire(self.request(), self.uid)
        self.assertEqual([], self.repo.all())
        missing = self.root / 'missing'
        with self.assertRaises(ValueError):
            LeaseRepository(missing, self.repo.routes, self.hosts)
        self.assertFalse(missing.exists())

    def test_reserved_namespaces_and_forged_listener_fail_closed(self):
        reserved = PreviewService(self.repo, {**self.config, 'reserved_namespaces': ['first-agent.test']})
        with self.assertRaises(ValueError):
            reserved.acquire(self.request(), self.uid)
        lease = self.service.acquire(self.request(), self.uid)
        record = {'pid': 12345, 'start_identity': '456'}
        for forged in [{**record, 'uid': self.uid + 1, 'listener_port': lease['port']},
                       {**record, 'uid': self.uid, 'listener_port': lease['port'] + 1}]:
            with patch('service.listener_identity', return_value=forged), patch('service.listener_matches', return_value=True):
                with self.assertRaises(ValueError):
                    self.service.activate({'id': lease['id'], 'process': record}, self.uid)


if __name__ == '__main__':
    unittest.main(verbosity=2)

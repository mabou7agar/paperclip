import json
import os
import pathlib
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from contracts import Refusal
from managed_mysql import current_job
from mysql_connections import MysqlConnectionRepository


class KernelSqlContextTests(unittest.TestCase):
    def test_only_one_actual_job_or_owner_unit_can_select_the_sql_scope(self):
        identity = str(uuid.uuid4())
        for kind in ['job', 'owner']:
            text = '0::/system.slice/paperclip-runner-' + kind + '-' + identity + '.service\n'
            with patch('managed_mysql.pathlib.Path.read_text', return_value=text):
                self.assertEqual(current_job(), (kind, identity))
        for text in ['0::/user.slice/arbitrary.service\n', '0::/system.slice/paperclip-runner-job-not-a-uuid.service\n',
                     '0::/system.slice/paperclip-runner-job-' + identity + '.service\n' +
                     '1:cpu:/system.slice/paperclip-runner-owner-' + str(uuid.uuid4()) + '.service\n']:
            with patch('managed_mysql.pathlib.Path.read_text', return_value=text), self.assertRaises(Refusal):current_job()


@unittest.skipUnless(sys.platform == 'linux' and os.getuid() == 0, 'real Linux root qualification only')
class MysqlConnectionReceiptTests(unittest.TestCase):
    def test_owned_connection_registry_retains_ids_and_rejects_restarted_server(self):
        with tempfile.TemporaryDirectory() as root:
            pathlib.Path(root).chmod(0o700);registry = MysqlConnectionRepository(root)
            binding = ['a' * 64, 'original-start']
            row = registry.register(321, binding, b'SELECT a_private_value;')
            self.assertEqual(registry.records(binding)[0]['connectionId'], 321)
            content = next(pathlib.Path(root).glob('mysql-connection-*.json')).read_text()
            self.assertNotIn('a_private_value', content)
            self.assertEqual(next(pathlib.Path(root).glob('mysql-connection-*.json')).stat().st_mode & 0o777, 0o600)
            registry.complete(row, 0)
            # Completion is a client receipt, not permission to lose server
            # identity while a killed query might still be settling.
            self.assertEqual(len(registry.records(binding)), 1)
            with self.assertRaises(Refusal):registry.records(['a' * 64, 'new-start'])

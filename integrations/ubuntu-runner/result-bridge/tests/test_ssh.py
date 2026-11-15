import pathlib
import sys
import unittest
import uuid
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from forced_remote import arguments, INSTALL
from contracts import Refusal


class SshTests(unittest.TestCase):
    def test_forced_command_has_no_shell_or_path_substitution(self):
        job = str(uuid.uuid4())
        prefix = 'python3 -I -B ' + INSTALL + '/remote_worker.py '
        self.assertEqual(arguments(prefix + '--inspect ' + job)[-2:], ['--inspect', job])
        self.assertEqual(arguments(prefix + '--stage')[-1], '--stage')
        for command in ['sh', prefix + '--run ' + job, prefix + '--inspect ' + job + '; id',
                        prefix + '--artifact ' + job + ' ../../secret', prefix + '--stage anything',
                        prefix.replace(INSTALL, '/tmp/replacement') + '--inspect ' + job]:
            with self.subTest(command=command), self.assertRaises(Refusal): arguments(command)

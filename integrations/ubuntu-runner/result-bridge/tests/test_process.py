import pathlib
import sys
import tempfile
import unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from bounded_process import capture


class ProcessTests(unittest.TestCase):
    def test_both_streams_are_drained_bounded_and_hashed(self):
        result = capture([sys.executable, '-c', 'import os;os.write(1,b"x"*1000);os.write(2,b"y"*1000)'], limit=2048)
        self.assertEqual(result['exit'], 0)
        self.assertEqual(result['stdout']['bytes'], 1000)
        self.assertEqual(result['stderr']['retained'], b'y' * 1000)

    def test_output_flood_terminates_only_owned_process_and_keeps_bounded_memory(self):
        result = capture([sys.executable, '-c', 'import os\nwhile True:os.write(1,b"x"*8192)'], limit=4096, grace=0.1)
        self.assertTrue(result['stdout']['overflow'])
        self.assertEqual(len(result['stdout']['retained']), 4096)
        self.assertNotEqual(result['exit'], 0)

    def test_timeout_allows_finally_cleanup_before_kill(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = pathlib.Path(directory) / 'cleanup'
            script = 'import pathlib,time\ntry:time.sleep(5)\nfinally:pathlib.Path(' + repr(str(marker)) + ').write_text("done")'
            result = capture([sys.executable, '-c', script], timeout=0.2, grace=2)
            self.assertTrue(result['timedOut'])
            self.assertEqual(marker.read_text(), 'done')

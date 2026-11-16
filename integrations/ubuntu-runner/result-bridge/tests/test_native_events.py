import json
import pathlib
import sys
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from native_events import NativeStateEvents


class NativeStateEventsTest(unittest.TestCase):
    def fixture(self, first='listening'):
        plugin = str(uuid.uuid4())
        program = '''import json,sys
plugin,first=sys.argv[1:]
def emit(kind): print(json.dumps({'kind':kind,'pluginId':plugin}),flush=True)
emit(first)
for line in sys.stdin: emit(line.strip())
'''
        return NativeStateEvents(plugin, command=[sys.executable, '-u', '-c', program, plugin, first])

    def test_commit_and_reconnect_events_are_coalesced_without_a_recurring_timer(self):
        observer = self.fixture()
        try:
            self.assertFalse(observer.wait(0))
            for kind in ['changed', 'listening']:
                observer.child.stdin.write(kind + '\n'); observer.child.stdin.flush()
                self.assertTrue(observer.wait(2))
                self.assertFalse(observer.wait(0))
        finally:
            observer.close()
        self.assertEqual(observer.child.returncode, 0)
        self.assertFalse(observer.thread.is_alive())

    def test_owner_loss_is_visible_and_does_not_silently_continue_without_notifications(self):
        observer = self.fixture()
        observer.child.stdin.close()
        try:
            with self.assertRaisesRegex(Exception, 'native_event_listener_unavailable'):
                observer.wait(2)
        finally:
            observer.close()
        self.assertEqual(observer.child.returncode, 0)

    def test_bad_startup_frames_fail_closed_and_release_the_child(self):
        for kind in ['unavailable', 'not-an-event']:
            with self.assertRaisesRegex(RuntimeError, 'native_event_listener_unavailable'):
                self.fixture(kind)

    def test_production_observer_is_unprivileged_and_clears_node_preloads(self):
        # Inject only the process creation; exercise the real pipe lifecycle.
        import subprocess
        original = subprocess.Popen
        calls = []
        plugin = str(uuid.uuid4())
        program = "import sys,json;print(json.dumps({'kind':'listening','pluginId':sys.argv[1]}),flush=True);sys.stdin.read()"
        def launch(argv, **options):
            calls.append(argv)
            return original([sys.executable, '-u', '-c', program, plugin], **options)
        with patch('native_events.subprocess.Popen', side_effect=launch):
            observer = NativeStateEvents(plugin)
        observer.close()
        argv = calls[0]
        self.assertEqual(argv[argv.index('--user') + 1], '1000:1000')
        self.assertIn('NODE_OPTIONS=', argv)
        self.assertIn('NODE_PATH=', argv)
        self.assertNotIn('DATABASE_URL', ' '.join(argv))


if __name__ == '__main__':
    unittest.main()

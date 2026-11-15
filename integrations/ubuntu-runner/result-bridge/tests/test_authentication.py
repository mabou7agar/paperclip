import hashlib
import hmac
import pathlib
import struct
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'broker'))
from authentication import PLUGIN, authenticate, verify_signature
from contracts import Refusal


class AuthenticationTests(unittest.TestCase):
    def test_an_agent_uid_cannot_use_a_valid_plugin_signature(self):
        connection = Mock()
        connection.getsockopt.return_value = struct.pack('3i', 99, 1000, 0)
        with patch('authentication.socket.SO_PEERCRED', 17, create=True):
            with self.assertRaisesRegex(Refusal, 'peer_authentication_refused'):
                authenticate(connection, {}, b'{}', {})

    def test_root_still_needs_the_exact_private_service_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory).resolve() / 'plugin-auth'
            path.write_text('a' * 64);path.chmod(0o600)
            connection = Mock()
            connection.getsockopt.return_value = struct.pack('3i', 99, 0, 0)
            raw = b'{"operation":"pending_deliveries","input":{}}'
            signature = hmac.new(b'a' * 64, PLUGIN.encode() + b'\n' + raw, hashlib.sha256).hexdigest()
            headers = {'X-Paperclip-Runner-Plugin': PLUGIN, 'X-Paperclip-Runner-Signature': signature}
            with patch('authentication.socket.SO_PEERCRED', 17, create=True):
                authenticate(connection, headers, raw, {'pluginAuthFile': str(path)})
                for patcher in [{**headers, 'X-Paperclip-Runner-Plugin': 'other.plugin'},
                                {**headers, 'X-Paperclip-Runner-Signature': '0' * 64}, {}]:
                    with self.assertRaises(Refusal): authenticate(connection, patcher, raw, {'pluginAuthFile': str(path)})
                with self.assertRaises(Refusal): authenticate(connection, headers, raw + b'changed', {'pluginAuthFile': str(path)})

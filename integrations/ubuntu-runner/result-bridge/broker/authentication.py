"""Only the dedicated root plugin service may use the privileged operator IPC.

Filesystem group membership is never authentication. The service signs every
request; native agent processes receive neither the credential nor root UID.
"""
import hashlib
import hmac
import socket
import struct
from configuration import private_file
from contracts import require

PLUGIN = 'paperclip.ubuntu-runner-results'


def verify_signature(secret, headers, raw):
    identity = headers.get('X-Paperclip-Runner-Plugin', '')
    supplied = headers.get('X-Paperclip-Runner-Signature', '')
    expected = hmac.new(secret, PLUGIN.encode() + b'\n' + raw, hashlib.sha256).hexdigest()
    require(identity == PLUGIN and hmac.compare_digest(supplied, expected), 'broker_authentication_refused')


def authenticate(connection, headers, raw, config):
    require(hasattr(socket, 'SO_PEERCRED'), 'broker_peer_authentication_not_supported')
    _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
    require(uid == 0, 'broker_peer_authentication_refused')
    secret = private_file(config['pluginAuthFile']).read_bytes().strip()
    require(len(secret) == 64 and all(x in b'0123456789abcdef' for x in secret), 'broker_authentication_configuration_invalid')
    verify_signature(secret, headers, raw)

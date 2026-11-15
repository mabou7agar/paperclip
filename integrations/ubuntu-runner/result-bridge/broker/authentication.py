"""Only the dedicated root plugin service may use the privileged operator IPC.

Filesystem group membership is never authentication. The service signs every
request; native agent processes receive neither the credential nor root UID.
"""
import hashlib
import hmac
import socket
import struct
import os
import pathlib
import select
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


def authenticate_control_hint_peer(connection, expected_uid, expected_profile):
    """Authenticate hints only, not privileged IPC or execution authority.

    SO_PEERPIDFD pins the socket's original peer, avoiding PID-reuse races in
    procfs label reads. No unsafe numeric-PID-only fallback is permitted.
    Linux 6.5+ ABI: include/uapi/asm-generic/socket.h, SO_PEERPIDFD=77.
    """
    pid,uid,_=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
    require(pid>0 and uid==expected_uid,'native_hint_peer_untrusted')
    peerfd=connection.getsockopt(socket.SOL_SOCKET,getattr(socket,'SO_PEERPIDFD',77))
    try:
        os.set_inheritable(peerfd,False)
        alive=select.poll();alive.register(peerfd,select.POLLIN|select.POLLHUP|select.POLLERR)
        require(not alive.poll(0),'native_hint_peer_exited')
        with pathlib.Path('/proc/self/fdinfo/'+str(peerfd)).open('rb') as file:info=file.read(8193)
        require(len(info)<=8192,'native_hint_peer_metadata_invalid')
        values=[line.split()[1] for line in info.splitlines() if line.startswith(b'Pid:')]
        require(values==[str(pid).encode()],'native_hint_peer_identity_changed')
        with pathlib.Path('/proc/'+str(pid)+'/attr/current').open('rb') as file:raw=file.read(4097)
        require(len(raw)<=4096 and raw.decode().strip()==expected_profile+' (enforce)', 'native_hint_peer_untrusted')
        require(not alive.poll(0),'native_hint_peer_exited')
    finally:
        os.close(peerfd)

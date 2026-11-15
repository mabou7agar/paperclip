"""Dedicated SSH authorized_keys forced command; no shell or forwarding."""
import os
import pathlib
import shlex
import sys
sys.path.insert(0, str(pathlib.Path(__file__).absolute().parent))
from contracts import UUID, SHA, require

INSTALL = '/opt/paperclip-ubuntu-runner-results'


def arguments(command):
    args = shlex.split(command)
    require(len(args) in [5, 6, 7] and args[:4] == ['python3', '-I', '-B', INSTALL + '/remote_worker.py'], 'ssh_command_refused')
    operation = args[4]
    if operation == '--stage':
        require(len(args) == 5, 'ssh_stage_arguments_refused')
    elif operation in ['--launch', '--inspect', '--cancel']:
        require(len(args) == 6 and UUID.fullmatch(args[5]), 'ssh_job_arguments_refused')
    elif operation == '--artifact':
        require(len(args) == 7 and UUID.fullmatch(args[5]) and SHA.fullmatch(args[6]), 'ssh_artifact_arguments_refused')
    else:
        require(False, 'ssh_operation_refused')
    return ['/usr/bin/python3', *args[1:]]


if __name__ == '__main__':
    require(os.getuid() == 0 and sys.flags.isolated and sys.dont_write_bytecode, 'ssh_boundary_required')
    args = arguments(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    os.execv(args[0], args)

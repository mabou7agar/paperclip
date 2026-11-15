"""Explicit Linux operator qualification in an isolated disposable MySQL.

Starts fixed synthetic work only. No candidate packet, application query/test,
provider, production database, shared MySQL setting or native task is executed.
The startup publisher is deliberately qualification-only: it cannot authorize a
production controller or supply the production accepted-readiness receipt.
"""
import concurrent.futures
import dataclasses
import importlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from types import SimpleNamespace

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'broker'
sys.path.insert(0, str(SOURCE))
from contracts import digest
from ownership_ledger import OwnershipLedger, process_identity
from owned_resources import OwnedResourceRepository
from mysql_connections import MysqlConnectionRepository
from managed_mysql import ManagedMysqlService
from setup_supervisor import SetupSupervisorService
from supervision_policy import SetupOwnership


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, timeout=30, **kwargs)


def qualify(runner, mysql_image):
    if os.getuid() != 0 or sys.platform != 'linux':
        raise RuntimeError('Explicit Linux root operator qualification required')
    prefix = 'pc-owner-qual-' + uuid.uuid4().hex[:16]
    base = pathlib.Path(tempfile.mkdtemp(prefix=prefix, dir='/tmp'));base.chmod(0o755)
    database = prefix + '-mysql'
    units = [];workspaces = [];repositories = []
    receipt = {'passed': False, 'candidatePackets': 0, 'applicationTests': 0,
               'applicationQueries': 0, 'providers': 0, 'imagesBuilt': 0,
               'productionAuthority': False, 'cases': []}
    run(['docker', 'create', '--name', database, '--network', 'none', '--memory', '1g',
         '--cpus', '1', '--pids-limit', '128', '--read-only',
         '--tmpfs', '/var/lib/mysql:rw,nosuid,size=512m',
         '--tmpfs', '/var/run/mysqld:rw,nosuid,size=16m', '--tmpfs', '/tmp:rw,nosuid,size=16m',
         '--env', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', mysql_image])
    run(['docker', 'start', database])
    try:
        deadline = time.monotonic() + 90
        while True:
            ping = subprocess.run(['docker', 'exec', database, 'mysqladmin', '-uroot', 'ping'], capture_output=True, timeout=5)
            ready = subprocess.run(['docker', 'exec', database, 'cat', '/proc/1/comm'], capture_output=True, timeout=5)
            if ping.returncode == 0 and ready.stdout.strip() == b'mysqld':break
            if time.monotonic() >= deadline:raise RuntimeError('Isolated MySQL did not start')
            time.sleep(.25)
        for expired in [False, True]:
            identity = str(uuid.uuid4());unit = 'paperclip-runner-job-' + identity;units.append(unit)
            root = base / identity;root.mkdir(mode=0o700)
            workspace = '/tmp/' + prefix + '-' + identity
            workspaces.append(workspace)
            run(['docker', 'exec', '--user', '1001:999', runner, 'mkdir', '-m700', workspace])
            spec = SetupOwnership(identity, 'qualification.only.v1', runner, database, 1001, 999,
                workspace, str(root / 'never-created-packet-owner'), 'qual-' + identity,
                ('qualcentral', 'qualprimary', 'qualisolation'), 'qual_account', workspace,
                ('runtime',), str(root / 'unused-production-startup.json'), 1800,
                '/etc/paperclip-runner-results/unused-qualification-only.json', '0' * 64)
            resources = OwnedResourceRepository(spec, registry=MysqlConnectionRepository(root))
            repositories.append(resources)
            resources.exact_absence();resources.private_absence()
            plan = {'admission': {'admission': {'qualificationOnly': True, 'jobId': identity}}}
            (root / 'spec.json').write_text(json.dumps(dataclasses.asdict(spec)));(root / 'spec.json').chmod(0o600)
            driver = base / ('driver-' + identity + '.py')
            driver.write_text('''import sys,pathlib,json,time,subprocess
sys.path.insert(0,SOURCE)
from supervision_policy import SetupOwnership
from owned_resources import OwnedResourceRepository
from mysql_connections import MysqlConnectionRepository
from managed_mysql import ManagedMysqlService
root=pathlib.Path(ROOT);value=json.loads((root/'spec.json').read_text());value['databases']=tuple(value['databases']);value['private_paths']=tuple(value['private_paths']);spec=SetupOwnership(**value)
r=OwnedResourceRepository(spec,registry=MysqlConnectionRepository(root))
if not EXPIRED:
 ManagedMysqlService(r,r.registry).execute(b"CREATE DATABASE qualcentral; CREATE USER 'qual_account'@'%';")
 subprocess.run(['docker','exec','--detach','--user','1001:999','--env','PAPERCLIP_RUNNER_JOB='+spec.run_id,spec.runner,'python3','-I','-B','-c','import pathlib,time;pathlib.Path('+repr(spec.private_root+'/runtime')+').mkdir();time.sleep(60)'],check=True,capture_output=True)
(root/'driver-ready').write_text('ready')
if not EXPIRED:ManagedMysqlService(r,r.registry).execute(b'SELECT SLEEP(60);',90)
else:time.sleep(60)
'''.replace('SOURCE', repr(str(SOURCE))).replace('ROOT', repr(str(root))).replace('EXPIRED', repr(expired)))
            run(['systemd-run', '--quiet', '--no-block', '--unit=' + unit, '--property=Type=exec',
                 '--property=Restart=no', '--property=KillMode=control-group', '--property=RuntimeMaxSec=120',
                 '--property=TimeoutStopSec=2', sys.executable, '-I', '-B', str(driver)])
            deadline = time.monotonic() + 15
            while not (root / 'driver-ready').exists():
                if time.monotonic() >= deadline:raise RuntimeError('Synthetic driver did not become ready')
                time.sleep(.05)
            pid = int(run(['systemctl', 'show', '--property=MainPID', '--value', unit], text=True).stdout.strip())
            lease = {'spec': dataclasses.asdict(spec), 'admissionCoreSha256': digest(plan['admission']['admission']),
                'containers': resources.bindings, 'driverPid': pid, 'driverStartTicks': process_identity(pid),
                'containerProcessStartTicks': int(time.clock_gettime(time.CLOCK_BOOTTIME) * os.sysconf('SC_CLK_TCK')) - 1500, 'startedUnix': time.time() - (1801 if expired else 0), 'expiresUnix': time.time() - 1 if expired else time.time() + 1800}
            ledger = OwnershipLedger(root);ledger.once('ownership-lease.json', lease)
            service = object.__new__(SetupSupervisorService)
            service.root, service.plan, service.packet, service.spec = root, plan, SimpleNamespace(directory='absent-qualification-packet'), spec
            service.ledger, service.resources = ledger, resources
            # This publishes NO production capability/measurement booleans.
            service.startup = lambda saved: ledger.once('qualification-startup.json', {'productionAuthority': False, 'jobId': identity})
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(service.watch)
                if not expired:
                    deadline = time.monotonic() + 10
                    while not resources.processes() or not resources.sessions():
                        if time.monotonic() >= deadline:raise RuntimeError('Synthetic owned work did not start')
                        time.sleep(.05)
                    # Kill only the driver; the synthetic container child and
                    # database query outlive its host process and need the owner.
                    run(['systemctl', 'kill', '--kill-whom=main', '--signal=KILL', unit])
                result = future.result(timeout=90)
            if not result['cleanupComplete'] or not service.host_work_empty():
                raise RuntimeError('Independent cleanup did not prove owned absence')
            resources.exact_absence();resources.private_absence()
            first = (root / 'ownership-final.json').read_bytes()
            if service.cleanup() != result or (root / 'ownership-final.json').read_bytes() != first:
                raise RuntimeError('Cleanup receipt changed or repeated work')
            receipt['cases'].append({'jobId': identity, 'case': 'expired_lease' if expired else 'driver_death_partial_setup',
                'passed': True, 'driverTerminated': True, 'hostCgroupEmpty': True,
                'containerProcessesAbsent': not resources.processes(), 'ownedSqlAbsent': not resources.sessions(),
                'schemasAndAccountAbsent': True, 'privateRuntimeAbsent': True, 'cleanupAttempts': 1,
                'executionRepeated': False, 'effectiveUid': 1001, 'effectiveGid': 999})
        receipt['passed'] = True
    finally:
        for unit in units:subprocess.run(['systemctl', 'stop', unit], capture_output=True, timeout=10)
        for resources in repositories:
            # Final safeguard is restricted to the disposable database and
            # this qualification's exact tagged non-root processes.
            resources.processes(cancel=True);resources.cancel_sessions()
        for workspace in workspaces:
            run(['docker','exec','--user','1001:999',runner,'rm','-rf','--',workspace])
        run(['docker', 'rm', '--force', database])
        receipt['disposableMysqlRemoved'] = True
        (base / 'qualification-receipt.json').write_text(json.dumps(receipt))
        print(json.dumps(receipt))
    return receipt


if __name__ == '__main__':
    if len(sys.argv) != 3:raise RuntimeError('Explicit runner name and existing MySQL image ID required')
    qualify(sys.argv[1], sys.argv[2])

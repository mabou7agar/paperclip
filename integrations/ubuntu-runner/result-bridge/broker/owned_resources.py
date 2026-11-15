"""Root operator resource reader/canceller, scoped by exact run identities.

The application cannot choose a SQL session ID or process selector. All
observations are closed metadata; credentials, SQL text and environments never
leave their container. Cancellation is not a test or a native agent wake.
"""
import json
import re
import subprocess
import sys
import pathlib
from contracts import require

# Runs on the protected host, restricted to PIDs positively listed by the
# registered container and its exact cgroup ID. No container ptrace capability
# or root permission is added to application/agent processes.
# Only effective UID/GID + exact inherited run tag selects a process. PID start
# ticks are re-read before signalling; no username-wide or guessed PGID kill.
PROCESS_READER = r'''
import os,pathlib,signal,sys,time,json
uid,gid,tag,action=int(sys.argv[1]),int(sys.argv[2]),sys.argv[3],sys.argv[4]
cutoff=None if sys.argv[7]=='none' else int(sys.argv[7])
allowed=set(json.loads(sys.argv[5]));container=sys.argv[6]
def read(pid):
 p=pathlib.Path('/proc')/str(pid)
 try:
  if int(pid) not in allowed or container not in (p/'cgroup').read_text():return None
  fields=(p/'stat').read_text().split(') ',1)[1].split(); status=(p/'status').read_text().splitlines()
  ids={line.split(':',1)[0]:line.split(':',1)[1].split() for line in status if line.startswith(('Uid:','Gid:'))}
  if int(ids['Uid'][1])!=uid or int(ids['Gid'][1])!=gid or fields[0]=='Z':return None
  env=(p/'environ').read_bytes().split(bytes([0]))
  owned=('PAPERCLIP_RUNNER_JOB='+tag).encode() in env
  if not owned and (cutoff is None or int(fields[19])<cutoff):return None
  return {'pid':int(pid),'startTicks':fields[19],'pgid':int(fields[2]),'state':fields[0],'ownership':'owned' if owned else 'unconfirmed'}
 except (FileNotFoundError,ProcessLookupError):return None
def scan():
 out=[r for p in pathlib.Path('/proc').iterdir() if p.name.isdigit() for r in [read(p.name)] if r]
 if len(out)>512:raise RuntimeError('owned process bound exceeded')
 return out
if action=='cancel':
 if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):raise RuntimeError('pidfd support required')
 frozen={}
 try:
  for _ in range(8):
   rows=scan()
   for row in rows:
    if row['ownership']!='owned' or row['pid'] in frozen:continue
    try:
     fd=os.pidfd_open(row['pid']);fresh=read(row['pid'])
     if not fresh or fresh['ownership']!='owned' or fresh['startTicks']!=row['startTicks']:os.close(fd);continue
     signal.pidfd_send_signal(fd,signal.SIGSTOP);frozen[row['pid']]=fd
    except ProcessLookupError:pass
   time.sleep(.025)
   if all(x['ownership']!='owned' or x['state'] in ['T','t'] for x in scan()):break
  for fd in frozen.values():
   try:signal.pidfd_send_signal(fd,signal.SIGKILL)
   except ProcessLookupError:pass
 finally:
  for fd in frozen.values():os.close(fd)
 for _ in range(40):
  if not any(x['ownership']=='owned' for x in scan()):break
  time.sleep(.05)
elif action!='inspect':raise RuntimeError('unknown action')
print(json.dumps({'processes':scan()}))
'''


class OwnedResourceRepository:
    def __init__(self, spec, registry=None):
        self.spec, self.registry = spec, registry
        self.bindings = {name: self.container_binding(name) for name in [spec.runner, spec.mysql]}

    def container_binding(self, name):
        value = subprocess.run(['docker', 'inspect', '--format', '{{json .Id}}|{{json .State.StartedAt}}', name],
                               capture_output=True, timeout=15)
        require(value.returncode == 0 and len(value.stdout) < 1024, 'setup_container_unavailable')
        parts = value.stdout.decode().strip().split('|')
        require(len(parts) == 2, 'setup_container_identity_invalid')
        return [json.loads(x) for x in parts]

    def unchanged(self, name):
        require(self.container_binding(name) == self.bindings[name], 'setup_container_restarted')

    def direct_principal_mapping(self):
        value = subprocess.run(['docker', 'inspect', '--format', '{{json .State.Pid}}', self.spec.runner],
                               capture_output=True, timeout=15)
        require(value.returncode == 0 and len(value.stdout) < 64, 'setup_container_namespace_unavailable')
        pid = json.loads(value.stdout)
        require(type(pid) is int and pid > 1, 'setup_container_namespace_invalid')
        for name, identity in [('uid_map', self.spec.uid), ('gid_map', self.spec.gid)]:
            mappings = [line.split() for line in (pathlib.Path('/proc') / str(pid) / name).read_text().splitlines()]
            require(all(len(row) == 3 and all(item.isdigit() for item in row) for row in mappings), 'setup_namespace_map_invalid')
            matches = [(int(row[0]), int(row[1]), int(row[2])) for row in mappings
                       if int(row[0]) <= identity < int(row[0]) + int(row[2])]
            require(len(matches) == 1 and matches[0][1] + identity - matches[0][0] == identity,
                    'setup_user_namespace_mapping_unsupported')

    def process_cutoff(self):
        if self.registry is None:return None
        path = self.registry.root / 'ownership-lease.json'
        if not path.exists():return None
        from contracts import closed_json
        from configuration import private_file
        lease = closed_json(private_file(path).read_bytes())
        value = lease.get('containerProcessStartTicks')
        require(type(value) is int and value >= 0, 'setup_process_lease_cutoff_missing')
        return value

    def processes(self, cancel=False):
        self.unchanged(self.spec.runner)
        self.direct_principal_mapping()
        listed = subprocess.run(['docker', 'top', self.spec.runner, '-eo', 'pid,uid,gid'], capture_output=True, timeout=15)
        require(listed.returncode == 0 and len(listed.stdout) <= 128 * 1024, 'setup_container_process_list_unconfirmed')
        rows = listed.stdout.decode().splitlines()
        require(rows and rows[0].split() == ['PID', 'UID', 'GID'], 'setup_container_process_list_invalid')
        pids = []
        for row in rows[1:]:
            fields = row.split()
            require(len(fields) == 3 and all(re.fullmatch(r'[0-9]+', field) for field in fields), 'setup_container_process_identity_invalid')
            if [int(fields[1]), int(fields[2])] == [self.spec.uid, self.spec.gid]:pids.append(int(fields[0]))
        require(len(pids) <= 512, 'setup_container_process_bound_exceeded')
        result = subprocess.run([sys.executable, '-I', '-B', '-c', PROCESS_READER,
            str(self.spec.uid), str(self.spec.gid), self.spec.run_id, 'cancel' if cancel else 'inspect',
            json.dumps(pids), self.bindings[self.spec.runner][0], str(self.process_cutoff()) if self.process_cutoff() is not None else 'none'], capture_output=True, timeout=20)
        require(result.returncode == 0 and len(result.stdout) <= 128 * 1024, 'setup_process_observation_unconfirmed')
        self.unchanged(self.spec.runner)
        value = json.loads(result.stdout)
        require(isinstance(value, dict) and set(value) == {'processes'} and isinstance(value['processes'], list),
                'setup_process_metadata_invalid')
        return value['processes']

    def sql(self, statement):
        self.unchanged(self.spec.mysql)
        # Root password exists only inside the registered database container.
        result = subprocess.run(['docker', 'exec', '-i', self.spec.mysql, 'sh', '-c',
            'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --skip-reconnect -uroot -N -B'],
            input=statement.encode(), capture_output=True, timeout=20)
        require(result.returncode == 0 and len(result.stdout) <= 32 * 1024, 'setup_sql_observation_unconfirmed')
        self.unchanged(self.spec.mysql)
        return result.stdout.decode().splitlines()

    def session_from(self):
        return 'information_schema.processlist t'

    def session_where(self):
        require(self.registry is not None, 'setup_root_session_registry_required')
        records = self.registry.records(self.bindings[self.spec.mysql])
        ids = ','.join(str(value['connectionId']) for value in records) or 'NULL'
        return ("(t.USER='" + self.spec.account + "' OR (t.USER='root' AND t.ID IN(" + ids + ')))')

    def sessions(self):
        # Administrative IDs are fsynced before SQL. The synthetic account
        # covers scoped imports/application connections without instrumentation.
        return self.sql('SELECT DISTINCT t.ID FROM ' + self.session_from() + ' WHERE ' + self.session_where() + ';')

    def cancel_sessions(self):
        for identity in self.sessions():
            require(re.fullmatch(r'[0-9]{1,20}', identity), 'setup_sql_session_identity_invalid')
            # Check ownership and prepare/execute KILL in one non-reconnecting
            # server session. A database restart cannot reconnect a stale ID to
            # an unrelated new session between the ownership test and the kill.
            exists = 'EXISTS(SELECT 1 FROM ' + self.session_from() + ' WHERE ' + self.session_where() + ' AND t.ID=' + identity + ')'
            statement = ("SET @paperclip_owned_stop=IF(" + exists + ",'KILL CONNECTION " + identity + "','DO 0'); "
                'PREPARE paperclip_owned_stop_stmt FROM @paperclip_owned_stop; '
                'EXECUTE paperclip_owned_stop_stmt; DEALLOCATE PREPARE paperclip_owned_stop_stmt;')
            try: self.sql(statement)
            except Exception:
                require(identity not in self.sessions(), 'setup_sql_cancel_unconfirmed')
        import time
        deadline = time.monotonic() + 10
        while self.sessions():
            require(time.monotonic() < deadline, 'setup_sql_sessions_still_active')
            time.sleep(.1)

    def exact_absence(self):
        names = "','".join(self.spec.databases)
        rows = self.sql("SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name IN ('" + names +
                        "'); SELECT COUNT(*) FROM mysql.user WHERE user='" + self.spec.account + "';")
        require(rows == ['0', '0'], 'setup_owned_resources_not_absent')
        require(not self.processes() and not self.sessions(), 'setup_owned_execution_not_absent')

    def remove_databases(self, execution):
        # Called only after host work, tagged container work and owned SQL
        # sessions have stopped under a lease that proved initial absence.
        execution.execute(("SET SESSION lock_wait_timeout=5; DROP USER IF EXISTS '" + self.spec.account + "'@'%';").encode())
        self.cancel_sessions()
        for name in self.spec.databases:
            execution.execute(('SET SESSION lock_wait_timeout=5; DROP DATABASE IF EXISTS `' + name + '`;').encode())

    def private_runtime(self, erase=False):
        self.unchanged(self.spec.runner)
        script = """import pathlib,sys,json,shutil
root=pathlib.Path(sys.argv[1]);names=json.loads(sys.argv[2]);erase=sys.argv[3]=='erase';errors=[]
if root.is_symlink() or not root.is_dir():raise RuntimeError('owned source root changed')
for name in names:
 path=root/name
 try:
  for parent in path.parents:
   if parent==root:break
   if parent.is_symlink():raise RuntimeError('private path ancestor changed')
  if erase:
   if path.is_symlink() or path.is_file():path.unlink()
   elif path.is_dir():shutil.rmtree(path)
  if path.exists() or path.is_symlink():errors.append(name)
 except Exception:errors.append(name)
print(json.dumps({'privateRuntimeAbsent':not errors}))
"""
        result = subprocess.run(['docker', 'exec', '--user', str(self.spec.uid)+':'+str(self.spec.gid),
            self.spec.runner, 'python3', '-I', '-B', '-c', script, self.spec.private_root,
            json.dumps(list(self.spec.private_paths)), 'erase' if erase else 'inspect'], capture_output=True, timeout=20)
        require(result.returncode == 0 and len(result.stdout) < 1024 and
                json.loads(result.stdout).get('privateRuntimeAbsent') is True, 'setup_private_runtime_still_present')
        self.unchanged(self.spec.runner)

    def private_absence(self):
        return self.private_runtime()

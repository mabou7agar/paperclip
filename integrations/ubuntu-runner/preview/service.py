"""Paperclip Ubuntu preview lifecycle. No provider, task, or session execution."""
import socket
import time
from certificates import ProjectCertificates
from domains import DomainPolicy
from processes import listener_identity, listener_matches
from requests import AcquireRequest, lease_key
from routing import internal_routes


class PreviewService:
    def __init__(self, repository, config, admission_guard=lambda: True):
        self.repository, self.config = repository, config
        self.admission_guard = admission_guard
        self.domains = DomainPolicy(config)
        self.issuer = ProjectCertificates(repository.root, config['tls_public'])

    def owned(self, key, uid):
        lease = self.repository.read(lease_key(key))
        if lease and lease['uid'] != uid:
            raise ValueError('The preview belongs to another caller.')
        return lease

    def public(self, lease):
        return {k: v for k, v in lease.items() if k not in ('certificate', 'processes')}

    def acquire(self, data, uid):
        request = AcquireRequest.parse(data, uid, self.config)
        project = self.config['projects'][request.project_id]
        hosts = self.domains.hosts(project, request.key, request.aliases)
        with self.repository.locked():
            if not self.admission_guard():
                raise ValueError('The ownership guard is unavailable or in maintenance.')
            self.collect()
            if self.owned(request.key, uid):
                raise ValueError('This lease was already acquired.')
            leases = self.repository.all()
            if any(set(hosts.values()) & set(x['private_hosts'].values()) for x in leases):
                raise ValueError('Project preview is occupied; use concurrent project configuration.')
            if sum(x['uid'] == uid for x in leases) >= 32:
                raise ValueError('Caller preview capacity reached.')
            occupied = {x['port'] for x in leases}
            for port in range(self.config['port_min'], self.config['port_max'] + 1):
                if port in occupied:
                    continue
                try:
                    with socket.socket() as probe:
                        probe.bind(('127.0.0.1', port))
                    break
                except OSError:
                    continue
            else:
                raise ValueError('No free preview port.')
            lease = {'id': request.key, 'uid': uid, 'company_id': request.company_id,
                     'project_id': request.project_id, 'workspace': request.workspace,
                     'private_hosts': hosts, 'port': port, 'state': 'starting', 'processes': {},
                     'expires_at': time.time() + self.config['lease_seconds'],
                     'starting_expires_at': time.time() + self.config['starting_seconds'],
                     'ca_bundle': self.config['tls_public'] + '/ca-bundle.crt'}
            try:
                self.repository.reserve_origin(self.domains.namespace(project), request.company_id, request.project_id, uid, request.key)
                certificate, pin = self.issuer.issue(request.key, hosts.values())
                lease.update(certificate=certificate, tls_spki=pin)
                self.repository.write(lease)
                self.repository.sync_hosts()
            except Exception:
                self.repository.remove(request.key)
                raise
            return self.public(lease)

    def activate(self, data, uid):
        if not isinstance(data, dict) or set(data) != {'id', 'process'}:
            raise ValueError('Invalid activation fields.')
        with self.repository.locked():
            if not self.admission_guard():
                raise ValueError('The ownership guard is unavailable or in maintenance.')
            lease = self.owned(data['id'], uid)
            if not lease or min(lease['expires_at'], lease.get('starting_expires_at', lease['expires_at'])) <= time.time():
                raise ValueError('Preview expired.')
            record = data['process']
            if not isinstance(record, dict) or set(record) != {'pid', 'start_identity'} or type(record['pid']) is not int or not isinstance(record['start_identity'], str):
                raise ValueError('Expected a managed process identity.')
            listener = listener_identity(record, lease, lease['port'])
            if not listener or listener.get('uid') != uid or listener.get('listener_port') != lease['port'] or not listener_matches(listener, lease):
                raise ValueError('The caller process does not own this preview listener.')
            lease.update(processes={'app': listener}, state='ready')
            lease.pop('starting_expires_at', None)
            try:
                self.repository.write(lease)
                self.repository.publish(lease, internal_routes(lease, self.config))
            except Exception:
                self.repository.remove(lease['id'])
                raise
            return self.public(lease)

    def release(self, key, uid):
        with self.repository.locked():
            if self.owned(key, uid):
                self.repository.remove(key)
        return {'id': key, 'state': 'expired'}

    def ready(self, key):
        lease = self.repository.read(lease_key(key))
        return bool(lease and lease['state'] == 'ready' and lease['expires_at'] > time.time()
                    and lease['processes'] and all(listener_matches(p, lease) for p in lease['processes'].values()))

    def collect(self):
        for lease in self.repository.all():
            if min(lease['expires_at'], lease.get('starting_expires_at', lease['expires_at'])) <= time.time() or (lease['state'] == 'ready' and not self.ready(lease['id'])):
                self.repository.remove(lease['id'])

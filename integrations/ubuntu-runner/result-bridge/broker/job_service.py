"""Own external work, not the agent lifecycle. Native Paperclip owns the latter."""
import hashlib
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contracts import canonical, digest, job_request, require, Refusal, closed_diagnostic
from packet import Packet
from admission import ReviewAdmissionService


class JobService:
    def __init__(self, config, repository, native, remote):
        self.config, self.repository, self.native, self.remote = config, repository, native, remote
        self.admission = ReviewAdmissionService(native)
        # Preserve the current single controlled execution slot. Callback
        # delivery has no provider and does not occupy that slot.
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='runner-job')
        self.pending = set()
        self.lock = threading.Lock()

    def profile(self, request):
        value = self.config['profiles'].get(request['profile'])
        require(value is not None, 'job_profile_not_registered')
        return value

    def submit(self, value):
        request = job_request(value)
        profile = self.profile(request)
        self.admission.binding(request, profile)
        identity, created = self.repository.register(request, profile['policyDigest'])
        if created:
            self.schedule(identity)
        return {'jobId': identity, 'state': self.repository.get(identity)['state'], 'replayed': not created,
                'next': 'Wait for the native runner-result delivery on this task. Do not poll, repeat tests, create a timer or ask the user. Report the concrete system-owned runner wait and end this turn.'}

    def schedule(self, identity):
        with self.lock:
            if identity in self.pending:
                return
            self.pending.add(identity)
        self.executor.submit(self.execute, identity).add_done_callback(lambda _: self.forget(identity))

    def forget(self, identity):
        with self.lock:
            self.pending.discard(identity)

    def recover(self):
        for identity, _ in self.repository.unfinished():
            self.schedule(identity)
        for identity in self.repository.pending():
            self.native.notify(identity)

    def load_packet(self, request, profile):
        attachments = self.native.read('/api/issues/' + request['taskId'] + '/attachments')
        matches = [x for x in attachments if x['id'] == request['attachmentId']]
        require(len(matches) == 1 and matches[0]['sha256'] == request['packetSha256'] and
                matches[0]['byteSize'] <= 16 * 1024 * 1024, 'job_attachment_binding_invalid')
        raw = self.native.read('/api/attachments/' + request['attachmentId'] + '/content?download=1',
                               limit=16 * 1024 * 1024, binary=True)
        return Packet(raw, request['packetSha256'], profile)

    def source_settled(self, request, profile):
        # The tool returns immediately; the native agent finishes its turn.
        # Only read persisted metadata while waiting. Never invoke a model.
        for _ in range(180):
            self.admission.binding(request, profile)
            rows = self.native.metadata(request['companyId'], [request['sourceRunId']], [])
            require(len(rows) == 1, 'job_source_run_missing')
            row = rows[0]
            require(row['agent'] == request['agentId'] and row['task'] == request['taskId'], 'job_source_run_scope_changed')
            if row['status'] not in ['queued', 'running']:
                require(row['status'] == 'succeeded' and row['before'] == row['after'] ==
                        profile['savedSessions'][request['agentId']], 'job_source_session_unsettled')
                return
            time.sleep(2)
        raise Refusal('job_source_run_not_settled')

    def execute(self, identity):
        saved = self.repository.get(identity)
        request = saved['input']
        profile = self.profile(request)
        try:
            require(saved['policy_digest'] == profile['policyDigest'], 'job_saved_policy_incompatible')
            if saved['state'] in ['launching', 'quarantined']:
                # Inspect the exact remote unit/result. A restart never turns
                # an uncertain attempt into a fresh execution.
                return self.follow(identity, request, profile, recover=True)
            if self.repository.ownership_holds(identity):
                # Admission waiting is not a spent execution or a model wake.
                # Recovery will observe the durable hold's actual release.
                return
            self.source_settled(request, profile)
            packet = self.load_packet(request, profile)
            if request['kind'] == 'reviewed_controller':
                admission = self.admission.controller(request, profile, packet)
            else:
                require(profile.get('allowControlChecks') is True and request['recipe'] in packet.files,
                        'job_control_checks_not_registered')
                admission = None
                inputs = {name: packet.file_sha(packet.directory + '/' + name) for name in profile['controlInputs']}
                key = digest([packet.file_sha(request['recipe']), inputs, profile['preparedImage'], profile['uid'], profile['gid']])
                previous = self.repository.passed_controls(key)
                if previous:
                    original_id, result = previous
                    return self.finish(identity, request, {**result['result'], 'reusedFromJobId': original_id})
            require(self.repository.claim(identity), 'job_already_claimed')
            self.remote.stage(profile, identity, request, packet, admission)
            # Re-read live task ownership immediately before launching.
            self.admission.binding(request, profile)
            self.remote.launch(profile, identity)
            return self.follow(identity, request, profile, control_key=key if request['kind'] == 'control_checks' else None)
        except Refusal as error:
            state = self.repository.get(identity)['state']
            self.finish(identity, request, {'status': 'unknown' if state in ['launching', 'quarantined'] else 'failed',
                                          'code': error.code, 'kind': request['kind']})
        except Exception:
            # Preserve the job and any remote ownership. No second command.
            self.finish(identity, request, {'status': 'unknown', 'code': 'job_execution_unreconciled', 'kind': request['kind']})

    def follow(self, identity, request, profile, recover=False, control_key=None):
        cancellation_requested = False
        for _ in range(1200):
            value = self.remote.inspect(profile, identity)
            if value['phase'] == 'terminal':
                outcome = closed_diagnostic(value['result'])
                published = []
                for item in outcome.pop('artifacts', []):
                    raw = self.remote.artifact(profile, identity, item['sha256'])
                    published.append(self.native.upload_evidence(request, item, raw))
                if published:
                    outcome['evidenceAttachments'] = published
                if control_key:
                    outcome['controlDigest'] = control_key
                return self.finish(identity, request, outcome)
            if recover and value['phase'] == 'not_staged':
                return self.finish(identity, request, {'status': 'unknown', 'kind': request['kind'], 'code': 'remote_launch_not_reconciled'})
            if recover and value['phase'] == 'staged':
                # The same remote job's exclusive attempt marker is the
                # execution identity. Re-delivering its unit is idempotent.
                self.admission.binding(request, profile)
                self.remote.launch(profile, identity)
            try:
                self.admission.binding(request, profile)
            except Refusal:
                if not cancellation_requested:
                    self.remote.cancel(profile, identity)
                    cancellation_requested = True
            time.sleep(2)
        if not cancellation_requested:
            self.remote.cancel(profile, identity)
        self.finish(identity, request, {'status': 'unknown', 'kind': request['kind'], 'code': 'remote_cleanup_or_termination_unconfirmed'})

    def finish(self, identity, request, outcome):
        # Exclude timestamps, process IDs, output hashes, packet identities and
        # counters from failure progress. A new attempt alone is not progress.
        meaningful = {k: outcome.get(k) for k in ['status', 'code', 'kind', 'diagnostic', 'steps', 'checks', 'recipeSha256'] if k in outcome}
        if outcome.get('kind') == 'control_checks':
            meaningful['facts'] = outcome.get('facts', {}).get('checks')
        result = {'jobId': identity, 'companyId': request['companyId'], 'projectId': request['projectId'],
                  'issueId': request['taskId'], 'agentId': request['agentId'], 'profile': request['profile'],
                  'status': outcome['status'], 'receiptSha256': digest(outcome), 'fingerprint': digest(meaningful), 'result': outcome}
        self.repository.terminal(identity, result)
        self.native.notify(identity)

    def status(self, value):
        saved = self.repository.get(value['jobId'])
        request = saved['input']
        require(value['companyId'] == request['companyId'] and value['agentId'] == request['agentId'], 'job_status_scope_mismatch')
        return {'jobId': saved['id'], 'state': saved['state'], 'result': saved['result']}

"""Own external work, not the agent lifecycle. Native Paperclip owns the latter."""
import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor
from contracts import canonical, digest, job_request, require, Refusal, AdmissionWait, closed_diagnostic
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
        self.admission.assert_profile(request, profile)
        require((request['kind'] == 'control_checks' and profile.get('allowControlChecks') is True) or
                (request['kind'] == 'reviewed_controller' and profile.get('allowReviewedController') is True), 'job_kind_not_enabled')
        identity, created = self.repository.register(request, profile['policyDigest'], self.slot(profile))
        if created:
            self.schedule(identity)
        saved = self.repository.get(identity)
        if saved['state'] == 'terminal':
            return {'jobId': identity, 'state': 'terminal', 'replayed': True, 'result': saved['result'],
                    'next': 'Result already retained. Use it in this native turn; do not wait, poll, repeat tests or reset the job.'}
        return {'jobId': identity, 'state': saved['state'], 'waitCode': saved['wait_code'], 'replayed': not created,
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
        return Packet(raw, request['packetSha256'], profile, privileged=request['kind'] == 'reviewed_controller')

    def slot(self, profile):
        return digest([profile['sshTarget'], profile['runner']])

    def source_settled(self, request, profile):
        self.admission.binding(request, profile)
        rows = self.native.metadata(request['companyId'], [request['sourceRunId']], [])
        require(len(rows) == 1, 'job_source_run_missing')
        row = rows[0]
        require(row['agent'] == request['agentId'] and row['task'] == request['taskId'], 'job_source_run_scope_changed')
        if row['status'] in ['queued', 'running']:
            raise AdmissionWait('job_source_run_not_settled')
        require(row['status'] == 'succeeded' and row['before'] == row['after'] ==
                profile['savedSessions'][request['agentId']], 'job_source_session_unsettled')

    def prepare(self, request, profile):
        self.source_settled(request, profile)
        if request['kind'] == 'reviewed_controller':
            self.admission.root_approval(request, profile)
        packet = self.load_packet(request, profile)
        if request['kind'] == 'reviewed_controller':
            require(profile.get('allowReviewedController') is True, 'job_controller_not_enabled')
            return packet, self.admission.controller(request, profile, packet), None
        require(profile.get('allowControlChecks') is True and request['recipe'] in packet.files,
                'job_control_checks_not_registered')
        inputs = {name: packet.file_sha(packet.directory + '/' + name) for name in profile['controlInputs']}
        key = digest([packet.file_sha(request['recipe']), inputs, profile['preparedImage'], profile['uid'], profile['gid']])
        return packet, {'controlDigest': key}, key

    def execute(self, identity):
        saved = self.repository.get(identity)
        request = saved['input']
        try:
            profile = self.profile(request)
            require(saved['policy_digest'] == profile['policyDigest'], 'job_saved_policy_incompatible')
            self.repository.bind_slot(identity, profile['policyDigest'], self.slot(profile))
            if saved['state'] in ['launching', 'quarantined', 'delivering']:
                return self.follow(identity, request, profile)
            if saved['state'] != 'queued':
                return
            if self.repository.ownership_holds(identity):
                return self.repository.wait(identity, 'runner_slot_owned')
            packet, admission, key = self.prepare(request, profile)
            if key:
                previous = self.repository.passed_controls(key, request['companyId'], request['profile'], profile['policyDigest'])
                if previous:
                    original_id, result = previous
                    return self.finish(identity, request, {**result['result'], 'reusedFromJobId': original_id})
            # Staging writes data only. A failed API read or partial SSH upload
            # before confirmed staging cannot consume the execution identity.
            self.remote.stage(profile, identity, request, packet, admission)
            # Re-verify the ENTIRE admission, including current target/verdict,
            # after staging and immediately before the first launch.
            current_packet, current_admission, _ = self.prepare(request, profile)
            require(digest(current_admission) == digest(admission), 'job_admission_changed_before_launch')
            require(self.repository.claim(identity), 'job_already_claimed')
            self.remote.launch(profile, identity)
            return self.follow(identity, request, profile)
        except AdmissionWait as error:
            self.repository.wait(identity, error.code)
        except Refusal as error:
            state = self.repository.get(identity)['state']
            if state in ['launching', 'quarantined'] and error.code in ['remote_transport_unconfirmed', 'remote_launch_unconfirmed', 'remote_unit_identity_unavailable']:
                # An SSH/client observation failure is not terminal evidence.
                # Keep the same ownership/attempt and let passive inspection
                # reconcile it; never wake or block the worker mid-execution.
                return self.repository.wait(identity, 'remote_observation_pending')
            if state == 'delivering':
                return self.repository.wait(identity, 'evidence_delivery_pending')
            if state == 'queued' and error.code in ['job_native_pause_hold', 'job_native_execution_hold', 'job_agent_unavailable', 'job_source_run_missing']:
                return self.repository.wait(identity, error.code)
            if state == 'queued' and error.code == 'remote_transport_unconfirmed':
                return self.repository.wait(identity, 'runner_staging_transport_pending')
            self.finish(identity, request, {'status': 'unknown' if state in ['launching', 'quarantined'] else 'failed',
                'code': error.code, 'kind': request['kind'], 'executionStarted': state != 'queued',
                'cleanupComplete': state == 'queued'})
        except Exception:
            state = self.repository.get(identity)['state']
            if state in ['queued', 'delivering']:
                return self.repository.wait(identity, 'native_or_delivery_transport_pending')
            return self.repository.wait(identity, 'remote_observation_pending')

    def follow(self, identity, request, profile):
        # One passive observation per recovery event. Do not hold the shared
        # executor on a six-minute source wait or forty-minute SSH poll loop.
        value = self.remote.inspect(profile, identity)
        if value['phase'] == 'terminal':
            outcome = closed_diagnostic(value['result'])
            if outcome.get('cleanupComplete') is True and outcome['status'] != 'unknown':
                self.repository.delivering(identity)
            published = []
            for item in outcome.pop('artifacts', []):
                raw = self.remote.artifact(profile, identity, item['sha256'])
                published.append(self.native.upload_evidence(request, item, raw))
            if published:
                outcome['evidenceAttachments'] = published
            return self.finish(identity, request, outcome)
        if value['phase'] == 'not_staged':
            # Launching is saved only AFTER staging was confirmed. Loss of
            # that remote state is identity loss, not permission to replay.
            return self.finish(identity, request, {'status': 'unknown', 'kind': request['kind'], 'code': 'remote_confirmed_state_missing'})
        if value['phase'] == 'staged':
            # No marker and no unit: a trusted positive pre-dispatch fact.
            try:
                packet, admission, _ = self.prepare(request, profile)
                self.remote.stage(profile, identity, request, packet, admission)
            except Refusal as error:
                if error.code in ['job_native_pause_hold', 'job_native_execution_hold', 'job_agent_unavailable',
                                  'job_source_run_not_settled', 'remote_transport_unconfirmed']:
                    return self.repository.release_unlaunched(identity, error.code)
                return self.finish(identity, request, {'status': 'failed', 'kind': request['kind'], 'code': error.code,
                    'executionStarted': False, 'cleanupComplete': True})
            except Exception:
                return self.repository.release_unlaunched(identity, 'native_transport_pending')
            self.remote.launch(profile, identity)
            return
        try:
            self.admission.binding(request, profile)
        except Refusal:
            if self.repository.request_cancel(identity):
                self.remote.cancel(profile, identity)

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
        return {'jobId': saved['id'], 'state': saved['state'], 'waitCode': saved['wait_code'], 'result': saved['result']}

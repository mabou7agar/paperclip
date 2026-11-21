"""Narrow read-only native provenance and delivery receipts."""
from contracts import SHA, UUID, canonical, digest, require
from native_envelope import PLUGIN_KEY


class NativeQueueReader:
    def __init__(self,native,plugin_id):
        require(isinstance(plugin_id,str) and UUID.fullmatch(plugin_id),'native_plugin_id_invalid')
        self.native,self.plugin_id=native,plugin_id

    def plugin_ready(self):
        rows=self.native.query("SELECT json_build_object('id',id,'key',plugin_key,'status',status) FROM plugins WHERE id='"+
            self.plugin_id+"' AND plugin_key='"+PLUGIN_KEY+"';")
        return len(rows)==1 and rows[0]['status']=='ready'

    def pending_intents(self,company):
        require(isinstance(company,str) and UUID.fullmatch(company),'native_company_id_invalid')
        return self.native.query("""SELECT json_build_object('key',s.state_key,'issue',s.scope_id,'value',s.value_json,
          'withinRun',s.updated_at>=h.started_at AND s.updated_at<=coalesce(h.finished_at,now()),
          'sourceMatches',h.company_id::text=s.value_json->>'companyId' AND h.agent_id::text=s.value_json->>'agentId'
            AND coalesce(h.native_issue_id::text,h.issue_id::text,h.context_snapshot->>'issueId')=s.scope_id)
          FROM plugin_state s LEFT JOIN heartbeat_runs h ON h.id::text=s.value_json->>'sourceRunId'
          WHERE s.plugin_id='%s' AND s.scope_kind='issue' AND s.namespace='runner-requests'
          AND s.value_json->>'companyId'='%s' ORDER BY s.id LIMIT 129;""" % (self.plugin_id,company))

    def wake_matches(self,request,key,identity,binding):
        require(all(UUID.fullmatch(request[x]) for x in ['companyId','agentId','taskId']) and UUID.fullmatch(identity) and
                all(c in '0123456789abcdef:-' for c in key.removeprefix('runner-result:').removeprefix('runner-admission:')) and
                len(binding)==64 and all(c in '0123456789abcdef' for c in binding),'native_wake_binding_invalid')
        rows=self.native.query("""SELECT json_build_object('matches',id='%s' AND company_id='%s' AND agent_id='%s'
          AND source='assignment' AND requested_by_actor_type='system' AND requested_by_actor_id='%s'
          AND idempotency_key='%s' AND payload->>'issueId'='%s' AND payload->>'pluginId'='%s'
          AND payload->>'pluginWakeupDigest'='%s') FROM agent_wakeup_requests WHERE id='%s';""" %
          (identity,request['companyId'],request['agentId'],self.plugin_id,key,request['taskId'],self.plugin_id,binding,identity))
        return len(rows)==1 and rows[0]['matches'] is True

    def admission_matches(self,request,identity,envelope):
        require(UUID.fullmatch(request['taskId']) and UUID.fullmatch(identity),'native_admission_binding_invalid')
        expected=canonical(envelope).decode()
        require("'" not in expected,'native_admission_encoding_invalid')
        rows=self.native.query("SELECT json_build_object('matches',value_json='%s'::jsonb) FROM plugin_state WHERE plugin_id='%s' AND scope_kind='issue' AND scope_id='%s' AND namespace='runner-admissions' AND state_key='%s';" %
            (expected,self.plugin_id,request['taskId'],identity))
        return len(rows)==1 and rows[0]['matches'] is True


    def policy_result_matches(self, request, result, envelope):
        """Recognize a committed native handoff for these exact signed bytes."""
        ids = (request['companyId'], request['taskId'], request['agentId'], result['jobId'])
        require(all(UUID.fullmatch(value) for value in ids) and SHA.fullmatch(result['receiptSha256']),
                'native_policy_result_binding_invalid')
        # Stock servers without the optional recovery schema still use the
        # legacy wake or recorded-only acknowledgment.
        if self.native.query("SELECT json_build_object('available',to_regclass('runner_recovery_results') IS NOT NULL);") != [{'available': True}]:
            return False
        rows = self.native.query("""SELECT json_build_object('matches',CASE
            WHEN r.state='deferred' THEN r.reason <> 'verification_unavailable'
            WHEN r.state='routing' THEN EXISTS (SELECT 1 FROM agent_wakeup_requests w
              WHERE w.id=r.wakeup_request_id AND w.company_id=r.company_id AND w.agent_id='%s'
              AND w.source='assignment' AND w.requested_by_actor_type='system'
              AND w.requested_by_actor_id=r.plugin_id::text AND w.idempotency_key=r.wake_idempotency_key
              AND w.payload->>'issueId'=r.issue_id::text AND w.payload->>'pluginId'=r.plugin_id::text
              AND (w.status IN ('queued','claimed') OR EXISTS (SELECT 1 FROM heartbeat_runs h
                WHERE h.id=w.run_id AND h.company_id=w.company_id AND h.agent_id=w.agent_id
                  AND h.wakeup_request_id=w.id AND h.started_at IS NOT NULL)))
            ELSE r.state IN ('routed','superseded','identical_fingerprint',
                             'exhausted','not_routable','not_terminal','replay_suppressed') END)
            FROM runner_recovery_results r
            WHERE r.company_id='%s' AND r.issue_id='%s' AND r.job_id='%s' AND r.plugin_id='%s'
              AND r.receipt_sha256='%s' AND r.envelope_sha256='%s' AND r.state_version>0;""" %
            (request['agentId'],request['companyId'],request['taskId'],result['jobId'],self.plugin_id,
             result['receiptSha256'],digest(envelope)))
        return len(rows) == 1 and rows[0]['matches'] is True

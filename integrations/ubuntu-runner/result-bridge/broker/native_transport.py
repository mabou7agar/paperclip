"""Native plugin intent → existing admission; signed action → native receipt ACK.

No candidate controls this transport, and it never assigns a task or manages a
provider session. A failed native read is a delivery wait, not an execution retry.
"""
import hashlib
import json
from configuration import private_file
from contracts import canonical, closed_json, digest, job_id, job_request, stable_input, require, Refusal
from native_envelope import EnvelopeSigner, PLUGIN_KEY
from native_queue_repository import NativeQueueRepository
from native_queue_reader import NativeQueueReader


def wake_receipt(company, plugin, key, issue, agent, reason, source):
    wire = lambda value: json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()
    value = hashlib.sha256(wire(['paperclip.plugin-wakeup.v1', company, plugin, key])).hexdigest()
    identity = value[:8]+'-'+value[8:12]+'-5'+value[13:16]+'-a'+value[17:20]+'-'+value[20:32]
    binding = hashlib.sha256(wire([company, plugin, issue, agent, key, reason, source])).hexdigest()
    return identity, binding


class NativeTransport:
    def __init__(self, config, service, native):
        self.config, self.service, self.native = config, service, native
        self.policy = config['nativeQueue']
        self.plugin_id = self.policy['pluginId']
        self.reader = NativeQueueReader(native,self.plugin_id)
        self.signer = EnvelopeSigner(self.policy['signingKeyFile'])
        self.ledger = NativeQueueRepository(service.repository)
        receipt = private_file(self.policy['isolationReceiptFile']).read_bytes()
        require(hashlib.sha256(receipt).hexdigest() == self.policy['isolationReceiptSha256'], 'native_isolation_receipt_changed')
        measured = closed_json(receipt)
        require(measured.get('schema') == 'paperclip.agent-isolation.v1' and measured.get('actualAgentQualified') is True and
                measured.get('serverEnvironmentOpenable') is False and measured.get('serverPipeOpenable') is False and
                measured.get('serverVaultOpenable') is False, 'native_agent_isolation_not_qualified')

    def identity(self):
        require(self.reader.plugin_ready(), 'native_plugin_binding_unavailable')

    def envelope(self, request, kind, data):
        sequence=self.service.repository.delivery_sequence(data['jobId'],data['receiptSha256']) if kind=='result' else 0
        return self.signer.sign({'schema':'paperclip.runner-envelope.v1','pluginKey':PLUGIN_KEY,'pluginId':self.plugin_id,
            'kind':kind,'companyId':request['companyId'],'projectId':request['projectId'],'issueId':request['taskId'],
            'agentId':request['agentId'],'jobId':job_id(request),'requestDigest':digest(stable_input(request)), 'sequence':sequence,'data':data})

    def receive(self):
        self.identity()
        # Independent per-company bounded scans: timestamps are not commit
        # order. A late transaction can never fall behind a recovery cursor.
        companies = sorted({profile['companyId'] for profile in self.config['profiles'].values()})
        unread=False
        for company in companies:
            try:
                rows = self.reader.pending_intents(company)
                require(len(rows)<=128, 'native_request_capacity_exceeded')
                for row in rows:
                    try:
                        request = job_request(row['value'])
                        require(len(canonical(request))<=16*1024 and row['key']==job_id(request) and row['issue']==request['taskId'] and
                                row['withinRun'] is True and row['sourceMatches'] is True, 'native_request_provenance_invalid')
                        self.ledger.bind(self.plugin_id,row['key'],request)
                        try:
                            profile = self.service.profile(request)
                            self.service.admission.assert_profile(request,profile)
                            response = self.service.submit(request)
                            response = {key:response[key] for key in ['jobId','state','waitCode','replayed'] if key in response}
                        except Refusal as error:
                            response = {'jobId':row['key'],'state':'not_admitted','code':error.code}
                        self.ledger.admission(row['key'],response)
                    except (Refusal,ValueError,KeyError,TypeError):
                        # Malformed/conflicting intent grants no execution and
                        # never suppresses another valid task/company's request.
                        continue
            except (Refusal,RuntimeError):
                unread=True
        require(not unread,'native_intent_scan_pending')

    def push(self, request, kind, data):
        return self.native.action(self.plugin_id,'receive-broker-envelope',request['companyId'],self.envelope(request,kind,data))

    def native_wake_ack(self, request, key, reason, source):
        identity, binding = wake_receipt(request['companyId'],self.plugin_id,key,request['taskId'],request['agentId'],reason,source)
        return self.reader.wake_matches(request,key,identity,binding)

    def recorded_only(self, request, result):
        issue = self.native.read('/api/issues/'+request['taskId'])
        require(issue['companyId']==request['companyId'] and issue['projectId']==request['projectId'], 'native_result_issue_changed')
        allowed = issue['status'] in ['done','cancelled'] or issue['assigneeAgentId']!=request['agentId'] or (
            result['newEvidence'] is False and result['status']!='passed' and
            (issue['status']=='blocked' or result['status']=='unknown'))
        if not allowed:return False
        try:
            document = self.native.read('/api/issues/'+request['taskId']+'/documents/runner-'+result['jobId']+'-'+result['receiptSha256'][:12])
        except RuntimeError:
            return False
        # Parse only the exact measured JSON block, never prose as authority.
        prefix = '# Runner result\n\nThis is measured execution evidence, not new execution or approval authority.\n\n```json\n'
        body = document.get('body','')
        if not body.startswith(prefix):return False
        raw, separator, _ = body[len(prefix):].partition('\n```\n\n')
        return bool(separator) and closed_json(raw)==result

    def deliver(self):
        self.identity()
        for row in self.ledger.pending_admissions():
            try:
                request,response = row['request'],row['admission']
                if response['state']=='not_admitted' and self.native_wake_ack(request,'runner-admission:'+row['job_id'],
                        'runner_admission_refused','ubuntu.runner.admission'):
                    self.ledger.acknowledge_admission(row['job_id']);continue
                self.push(request,'admission',response)
                if response['state']!='not_admitted' or self.native_wake_ack(request,'runner-admission:'+row['job_id'],
                        'runner_admission_refused','ubuntu.runner.admission') or self.closed_admission_ack(request,response):
                    self.ledger.acknowledge_admission(row['job_id'])
            except Exception:
                continue

        for identity in self.service.repository.pending():
            try:
                saved = self.service.repository.get(identity)
                request,result = saved['input'],saved['result']
                # Native ACK is checked before another push after an ambiguous
                # response or broker restart. No provider ever gets a second key.
                key = 'runner-result:'+identity+':'+result['receiptSha256']
                if not self.native_wake_ack(request,key,'runner_result_received','ubuntu.runner.result') and not self.recorded_only(request,result):
                    self.push(request,'result',result)
                if self.native_wake_ack(request,key,'runner_result_received','ubuntu.runner.result') or self.recorded_only(request,result):
                    self.service.repository.acknowledge(identity,result['receiptSha256'])
            except Exception:
                continue

    def closed_admission_ack(self,request,response):
        issue = self.native.read('/api/issues/'+request['taskId'])
        if issue['companyId']!=request['companyId'] or issue['projectId']!=request['projectId'] or not (
                issue['status'] in ['done','cancelled'] or issue['assigneeAgentId']!=request['agentId']):return False
        return self.reader.admission_matches(request,job_id(request),self.envelope(request,'admission',response))

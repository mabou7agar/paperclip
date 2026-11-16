"""Authenticated native records and narrow read-only run attestation."""
import json
import uuid
import hashlib
import pathlib
import subprocess
import urllib.error
import urllib.request
from contracts import UUID, require, closed_json
from configuration import private_file


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


class NativeRepository:
    def __init__(self, config):
        self.config = config
        self.opener = urllib.request.build_opener(NoRedirect())

    def read(self, path, limit=2 * 1024 * 1024, binary=False):
        require(path.startswith("/api/") and ".." not in path and "#" not in path, "native_path_invalid")
        token = private_file(self.config["tokenFile"]).read_text().strip()
        req = urllib.request.Request(self.config["apiBaseUrl"].rstrip("/") + path,
                                     headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
        try:
            with self.opener.open(req, timeout=20) as response:
                require(response.status == 200, "native_read_refused")
                raw = response.read(limit + 1)
                require(len(raw) <= limit, "native_response_too_large")
        except (OSError, urllib.error.URLError):
            raise RuntimeError("native_read_unavailable") from None
        return raw if binary else closed_json(raw)

    def comment(self, issue_id, comment_id):
        require(UUID.fullmatch(issue_id) and UUID.fullmatch(comment_id), "native_comment_id_invalid")
        return self.read(f"/api/issues/{issue_id}/comments/{comment_id}")

    def deliver_envelope(self, plugin_id, envelope):
        require(UUID.fullmatch(plugin_id), 'native_delivery_scope_invalid')
        from contracts import canonical
        body = canonical(envelope)
        require(len(body)<=192*1024, 'native_delivery_too_large')
        request = urllib.request.Request(self.config['apiBaseUrl'].rstrip('/')+'/api/plugins/'+plugin_id+'/webhooks/terminal',
            data=body,headers={'Content-Type':'application/json'})
        with self.opener.open(request,timeout=25) as response:
            require(response.status==200, 'native_delivery_unconfirmed')
            raw = response.read(16385)
            require(len(raw)<=16384, 'native_delivery_response_too_large')
            # Transport acknowledgement only. The owning service independently
            # verifies the actual native state/document/wake before ledger ACK.
            return closed_json(raw)

    def admission_gates_sql(self, company_id, task_id):
        require(UUID.fullmatch(company_id) and UUID.fullmatch(task_id), 'native_gate_ids_invalid')
        sql = f"""SELECT json_build_object('companyActive',c.status='active' AND c.paused_at IS NULL,
          'projectActive',p.id IS NULL OR p.paused_at IS NULL,
          'pauseHeld',EXISTS(SELECT 1 FROM issue_tree_hold_members m JOIN issue_tree_holds h ON h.id=m.hold_id
             WHERE m.company_id=c.id AND m.issue_id=i.id AND NOT m.skipped AND h.status='active' AND h.mode='pause'))
          FROM issues i JOIN companies c ON c.id=i.company_id LEFT JOIN projects p ON p.id=i.project_id
          WHERE i.company_id='{company_id}' AND i.id='{task_id}';"""
        return sql

    def admission_gates(self, company_id, task_id):
        rows = self.query(self.admission_gates_sql(company_id, task_id))
        require(len(rows) == 1, 'native_admission_gate_missing')
        return rows[0]

    def query(self, sql):
        cmd = ['docker', 'exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', '-i',
               self.config['databaseContainer'], 'psql', '-XqAt', '-U', self.config['databaseUser'],
               '-d', self.config['databaseName'], '-v', 'ON_ERROR_STOP=1']
        result = subprocess.run(cmd, input=sql.encode(), capture_output=True, timeout=20)
        require(result.returncode == 0 and len(result.stdout) <= 256 * 1024, 'native_attestation_unavailable')
        return [closed_json(line) for line in result.stdout.splitlines() if line]

    def metadata_sql(self, company_id, run_ids, source_decisions):
        require(UUID.fullmatch(company_id) and len(run_ids) <= 256 and all(UUID.fullmatch(x) for x in run_ids), "native_run_ids_invalid")
        require(len(source_decisions) <= 16 and all(UUID.fullmatch(x) for x in source_decisions), "native_decision_ids_invalid")
        runs = ",".join("'" + x + "'" for x in run_ids) or "NULL"
        decisions = ",".join("'" + x + "'" for x in source_decisions) or "NULL"
        # No provider transcript or reasoning is selected. The command is
        # tested as a boolean inside PostgreSQL and never returned.
        sql = f"""SELECT json_build_object('kind','run','id',h.id,'agent',h.agent_id,'status',h.status,
          'before',h.session_id_before,'after',h.session_id_after,'finished',h.finished_at,
          'task',coalesce(h.native_issue_id::text,h.issue_id::text,h.context_snapshot->>'issueId'),
          'provider',h.context_snapshot->'aiConnection'->>'provider',
          'actualACP',EXISTS(SELECT 1 FROM heartbeat_run_events e WHERE e.run_id=h.id AND e.event_type='adapter.invoke' AND e.payload->>'command' LIKE '%claude-agent-acp%'))
          FROM heartbeat_runs h WHERE h.company_id='{company_id}' AND h.id IN({runs});
        SELECT json_build_object('kind','decision','id',id,'issue',issue_id,'stageId',stage_id,'outcome',outcome,'bodyMd5',md5(body))
          FROM issue_execution_decisions WHERE company_id='{company_id}' AND id IN({decisions});"""
        return sql

    def metadata(self, company_id, run_ids, source_decisions):
        return self.query(self.metadata_sql(company_id, run_ids, source_decisions))

    def upload_evidence(self, job, descriptor, raw):
        require(hashlib.sha256(raw).hexdigest() == descriptor['sha256'] and len(raw) == descriptor['bytes'], 'artifact_upload_digest_mismatch')
        previous = self.read('/api/issues/' + job['taskId'] + '/attachments')
        existing = [x for x in previous if x['sha256'] == descriptor['sha256'] and x['byteSize'] == len(raw)]
        if existing:
            return {'attachmentId': existing[0]['id'], **descriptor}
        from evidence import KINDS
        require(descriptor['kind'] in KINDS, 'artifact_upload_kind_invalid')
        boundary = 'paperclip' + uuid.uuid4().hex
        name = descriptor['fileName']
        require(__import__('re').fullmatch(r'[A-Za-z0-9_-]+\.(png|webm|json)', name), 'artifact_upload_name_invalid')
        body = ('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + name +
                '"\r\nContent-Type: ' + KINDS[descriptor['kind']] + '\r\n\r\n').encode() + raw + ('\r\n--' + boundary + '--\r\n').encode()
        token = private_file(self.config['tokenFile']).read_text().strip()
        request = urllib.request.Request(self.config['apiBaseUrl'].rstrip('/') + '/api/companies/' + job['companyId'] +
                  '/issues/' + job['taskId'] + '/attachments', data=body,
                  headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + boundary})
        # A lost response is reconciled against attachment digests on the next
        # delivery. Never remove an attachment after an ambiguous commit.
        with self.opener.open(request, timeout=90) as response:
            require(response.status in [200, 201], 'artifact_upload_unconfirmed')
            value = closed_json(response.read(32769))
        require(value['sha256'] == descriptor['sha256'] and value['byteSize'] == len(raw), 'artifact_upload_receipt_mismatch')
        return {'attachmentId': value['id'], **descriptor}

    def notify(self, job_id):
        url = self.config["callbackUrl"]
        if not url:
            return False
        body = json.dumps({"jobId": job_id}).encode()
        try:
            with self.opener.open(urllib.request.Request(url, data=body,
                                 headers={"Content-Type": "application/json"}), timeout=10) as response:
                return 200 <= response.status < 300
        except (OSError, urllib.error.URLError):
            return False

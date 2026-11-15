"""First-seen native intents live in the root ledger, never task/session state."""
from contracts import canonical, digest, require, UUID


class NativeQueueRepository:
    def __init__(self, repository):
        self.repository = repository
        with repository.connection() as db:
            db.execute('CREATE TABLE IF NOT EXISTS native_requests(plugin_id TEXT NOT NULL, job_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, request_json TEXT NOT NULL, admission_json TEXT, admission_delivered INTEGER NOT NULL DEFAULT 0)')
            db.execute('CREATE TABLE IF NOT EXISTS native_hints(job_id TEXT PRIMARY KEY,company_id TEXT NOT NULL,source_run_id TEXT NOT NULL,task_id TEXT NOT NULL,observed INTEGER NOT NULL DEFAULT 0)')

    def retain_hint(self,value,companies):
        require(isinstance(value,dict) and set(value)=={'companyId','jobId','sourceRunId','taskId'} and
                all(isinstance(x,str) and UUID.fullmatch(x) for x in value.values()) and
                value['companyId'] in companies,'native_hint_invalid')
        with self.repository.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT * FROM native_hints WHERE job_id=?',(value['jobId'],)).fetchone()
            if row:
                require((row['company_id'],row['source_run_id'],row['task_id'])==
                        (value['companyId'],value['sourceRunId'],value['taskId']),'native_hint_conflict')
                return
            require(db.execute('SELECT count(*) FROM native_hints WHERE company_id=? AND observed=0',
                    (value['companyId'],)).fetchone()[0]<128,'native_hint_capacity_wait')
            db.execute('INSERT INTO native_hints(job_id,company_id,source_run_id,task_id)VALUES(?,?,?,?)',
                       (value['jobId'],value['companyId'],value['sourceRunId'],value['taskId']))

    def observe_hint(self,request,identity):
        with self.repository.connection() as db:
            db.execute('UPDATE native_hints SET observed=1 WHERE job_id=? AND company_id=? AND source_run_id=? AND task_id=?',
                       (identity,request['companyId'],request['sourceRunId'],request['taskId']))

    def has_pending_hints(self):
        with self.repository.connection() as db:
            return db.execute('SELECT 1 FROM native_hints WHERE observed=0 LIMIT 1').fetchone() is not None

    def bind(self, plugin_id, identity, request):
        with self.repository.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM native_requests WHERE job_id=?', (identity,)).fetchone()
            if row:
                require(row['plugin_id'] == plugin_id and row['request_digest'] == digest(request), 'native_request_conflict')
                return
            db.execute('INSERT INTO native_requests(plugin_id,job_id,request_digest,request_json)VALUES(?,?,?,?)',
                       (plugin_id, identity, digest(request), canonical(request).decode()))

    def admission(self, identity, response):
        with self.repository.connection() as db:
            # First response is immutable. Live status follows native result
            # delivery; recovery does not mutate a prior admission receipt.
            db.execute('UPDATE native_requests SET admission_json=? WHERE job_id=? AND admission_json IS NULL',
                       (canonical(response).decode(), identity))

    def pending_admissions(self):
        import json
        with self.repository.connection() as db:
            rows = db.execute('SELECT * FROM native_requests WHERE admission_json IS NOT NULL AND admission_delivered=0 ORDER BY rowid LIMIT 128').fetchall()
        return [{**dict(row), 'request': json.loads(row['request_json']), 'admission': json.loads(row['admission_json'])} for row in rows]

    def acknowledge_admission(self, identity):
        with self.repository.connection() as db:
            db.execute('UPDATE native_requests SET admission_delivered=1 WHERE job_id=?', (identity,))

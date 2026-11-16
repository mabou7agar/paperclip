"""First-seen native intents live in the root ledger, never task/session state."""
from contracts import canonical, digest, require, UUID


class NativeQueueRepository:
    def __init__(self, repository):
        self.repository = repository
        with repository.connection() as db:
            db.execute('CREATE TABLE IF NOT EXISTS native_requests(plugin_id TEXT NOT NULL, job_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, request_json TEXT NOT NULL, admission_json TEXT, admission_delivered INTEGER NOT NULL DEFAULT 0)')

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

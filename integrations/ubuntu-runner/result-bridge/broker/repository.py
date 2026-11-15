"""The broker's durable job/outbox ledger. SQLite never owns Paperclip state."""
import json
import os
import pathlib
import sqlite3
import stat
from contextlib import contextmanager
from contracts import canonical, digest, job_id, stable_input, require


class JobRepository:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        st = self.root.lstat()
        require(self.root.is_dir() and not self.root.is_symlink() and st.st_uid == os.getuid() and
                stat.S_IMODE(st.st_mode) == 0o700, "job_state_root_untrusted")
        self.path = self.root / "jobs.sqlite3"
        if self.path.exists():
            st = self.path.lstat()
            require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o600, "job_database_untrusted")
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,input_digest TEXT NOT NULL,input_json TEXT NOT NULL,policy_digest TEXT NOT NULL,state TEXT NOT NULL,slot_id TEXT NOT NULL DEFAULT '',cancel_requested INTEGER NOT NULL DEFAULT 0,wait_code TEXT,result_json TEXT,delivered INTEGER NOT NULL DEFAULT 0)")
            columns = {row[1] for row in db.execute('PRAGMA table_info(jobs)')}
            for name, declaration in [('slot_id', "TEXT NOT NULL DEFAULT ''"), ('cancel_requested', 'INTEGER NOT NULL DEFAULT 0'), ('wait_code', 'TEXT')]:
                if name not in columns:
                    db.execute('ALTER TABLE jobs ADD COLUMN ' + name + ' ' + declaration)
            db.execute("CREATE INDEX IF NOT EXISTS jobs_input_digest_idx ON jobs(input_digest)")
            db.execute("CREATE TABLE IF NOT EXISTS observations(scope TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(scope,fingerprint))")
            db.execute("CREATE TABLE IF NOT EXISTS deliveries(job_id TEXT NOT NULL,receipt_sha TEXT NOT NULL,result_json TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job_id,receipt_sha))")
        self.path.chmod(0o600)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                db.execute("PRAGMA synchronous=FULL")
                db.row_factory = sqlite3.Row
                yield db
        finally:
            db.close()

    def register(self, request, policy_digest, slot_id=None):
        identity = job_id(request)
        fingerprint = digest(stable_input(request))
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            legacy = db.execute('SELECT id FROM jobs WHERE input_digest=? LIMIT 2', (fingerprint,)).fetchall()
            require(len(legacy) <= 1, 'job_legacy_identity_ambiguous')
            if legacy:
                identity = legacy[0]['id']
            row = db.execute("SELECT * FROM jobs WHERE id=?", (identity,)).fetchone()
            if row:
                require(row["input_digest"] == fingerprint and row["policy_digest"] == policy_digest, "job_replay_identity_conflict")
                return identity, False
            db.execute("INSERT INTO jobs(id,input_digest,input_json,policy_digest,state,slot_id)VALUES(?,?,?,?,?,?)",
                       (identity, fingerprint, canonical(request).decode(), policy_digest, "queued", slot_id or digest([request["companyId"],request["profile"]])))
        return identity, True

    def get(self, identity):
        with self.connection() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (identity,)).fetchone()
        require(row is not None, "job_not_found")
        value = dict(row)
        value["input"] = json.loads(value.pop("input_json"))
        raw_result = value.pop("result_json")
        value["result"] = json.loads(raw_result) if raw_result else None
        return value

    def claim(self, identity):
        with self.connection() as db:
            return db.execute("UPDATE jobs SET state='launching',wait_code=NULL WHERE id=? AND state='queued'", (identity,)).rowcount == 1

    def terminal(self, identity, result):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute("SELECT state,result_json,input_json FROM jobs WHERE id=?", (identity,)).fetchone()
            require(current is not None, "job_not_found")
            old = db.execute("SELECT result_json FROM deliveries WHERE job_id=? AND receipt_sha=?", (identity, result['receiptSha256'])).fetchone()
            if old:
                saved = json.loads(old[0])
                require({k: v for k, v in saved.items() if k != "newEvidence"} == result, "job_terminal_conflict")
                return saved
            require(current['state'] != 'terminal', 'job_terminal_conflict')
            request = json.loads(current["input_json"])
            scope = digest([request["companyId"], request["taskId"], request["kind"]])
            fresh = result["status"] == "passed" or db.execute("INSERT OR IGNORE INTO observations(scope,fingerprint)VALUES(?,?)", (scope, result["fingerprint"])).rowcount == 1
            result = {**result, "newEvidence": fresh}
            state = 'quarantined' if result['status'] == 'unknown' or result['result'].get('cleanupComplete') is False else 'terminal'
            db.execute("INSERT INTO deliveries(job_id,receipt_sha,result_json)VALUES(?,?,?)", (identity, result['receiptSha256'], canonical(result).decode()))
            db.execute("UPDATE jobs SET state=?,result_json=?,wait_code=NULL WHERE id=?", (state, canonical(result).decode(), identity))
        return result

    def pending(self):
        with self.connection() as db:
            return list(dict.fromkeys(row[0] for row in db.execute("SELECT job_id FROM deliveries WHERE delivered=0 ORDER BY rowid LIMIT 100")))

    def unfinished(self):
        with self.connection() as db:
            return [(row[0], row[1]) for row in db.execute("SELECT id,state FROM jobs WHERE state IN('queued','launching','quarantined','delivering') ORDER BY rowid")]

    def acknowledge(self, identity, receipt_sha):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT rowid FROM deliveries WHERE job_id=? AND receipt_sha=?", (identity, receipt_sha)).fetchone()
            require(row is not None, "job_acknowledgement_conflict")
            # The latest receipt supersedes older pending observations of the
            # same job. A late ACK of an older observation must not consume a
            # newer result. Immutable receipt bodies remain in the ledger.
            db.execute("UPDATE deliveries SET delivered=1 WHERE job_id=? AND rowid<=?", (identity, row[0]))

    def ownership_holds(self, identity):
        with self.connection() as db:
            return [row[0] for row in db.execute("SELECT id FROM jobs WHERE state IN('launching','quarantined') AND id<>? AND (slot_id='' OR slot_id=(SELECT slot_id FROM jobs WHERE id=?))", (identity,identity))]

    def passed_controls(self, control_digest, company_id, profile, policy_digest):
        with self.connection() as db:
            rows = db.execute("SELECT id,result_json,input_json,policy_digest FROM jobs WHERE state='terminal' AND result_json IS NOT NULL ORDER BY rowid DESC")
            for row in rows:
                bound = json.loads(row['input_json'])
                if bound['companyId'] != company_id or bound['profile'] != profile or row['policy_digest'] != policy_digest:
                    continue
                result = json.loads(row['result_json'])
                if result['status'] == 'passed' and result['result'].get('controlDigest') == control_digest:
                    return row['id'], result
        return None

    def request_cancel(self, identity):
        with self.connection() as db:
            return db.execute('UPDATE jobs SET cancel_requested=1 WHERE id=? AND cancel_requested=0', (identity,)).rowcount == 1

    def bind_slot(self, identity, policy_digest, slot_id):
        with self.connection() as db:
            row = db.execute('SELECT slot_id,policy_digest FROM jobs WHERE id=?', (identity,)).fetchone()
            require(row is not None and row['policy_digest'] == policy_digest, 'job_saved_policy_incompatible')
            require(row['slot_id'] in ['', slot_id], 'job_slot_identity_changed')
            db.execute('UPDATE jobs SET slot_id=? WHERE id=?', (slot_id, identity))

    def wait(self, identity, code):
        with self.connection() as db:
            db.execute('UPDATE jobs SET wait_code=? WHERE id=?', (code, identity))

    def delivering(self, identity):
        with self.connection() as db:
            db.execute("UPDATE jobs SET state='delivering',wait_code=NULL WHERE id=? AND state IN('launching','quarantined')", (identity,))

    def release_unlaunched(self, identity, reason):
        # Called only after the trusted remote reader positively observes no
        # attempt marker and no pending/running unit. No execution is reset.
        with self.connection() as db:
            db.execute("UPDATE jobs SET state='queued',wait_code=? WHERE id=? AND state IN('launching','quarantined')", (reason, identity))

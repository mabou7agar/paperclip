-- Run only against an explicitly authorized isolated scratch Postgres instance:
-- psql "$SCRATCH_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f this-file.sql
-- No application schema is read or changed; rollback is mandatory.
BEGIN;
CREATE TEMP TABLE source_snapshot_check(id text, company_id text, context_snapshot jsonb);
INSERT INTO source_snapshot_check VALUES ('run','company','{"unrelated":"preserved"}'),('retry','company','{}');
DO $$
DECLARE affected integer;
BEGIN
 UPDATE source_snapshot_check SET context_snapshot=coalesce(context_snapshot,'{}'::jsonb) || '{"sourceSnapshot":{"workspaceId":"workspace","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'::jsonb
 WHERE id='run' AND company_id='other' AND context_snapshot->'sourceSnapshot' IS NULL;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>0 THEN RAISE EXCEPTION 'cross-company write'; END IF;
 UPDATE source_snapshot_check SET context_snapshot=coalesce(context_snapshot,'{}'::jsonb) || '{"sourceSnapshot":{"workspaceId":"workspace","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'::jsonb
 WHERE id='run' AND company_id='company' AND context_snapshot->'sourceSnapshot' IS NULL;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'first snapshot did not win'; END IF;
 UPDATE source_snapshot_check SET context_snapshot='{}' WHERE id='run' AND company_id='company' AND context_snapshot->'sourceSnapshot' IS NULL;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>0 THEN RAISE EXCEPTION 'duplicate snapshot overwrite'; END IF;
 IF (SELECT context_snapshot->>'unrelated' FROM source_snapshot_check WHERE id='run')<>'preserved' THEN RAISE EXCEPTION 'unrelated context lost'; END IF;
 UPDATE source_snapshot_check SET context_snapshot=coalesce(context_snapshot,'{}'::jsonb) || '{"sourceSnapshot":{"workspaceId":"workspace","revision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}'::jsonb
 WHERE id='retry' AND company_id='company' AND context_snapshot->'sourceSnapshot' IS NULL;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'fresh retry could not bind'; END IF;
END $$;
ROLLBACK;

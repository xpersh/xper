-- A run belongs to one Pi session. Earlier versions allowed an explicit join.
-- Keep the original binding and detach later sessions from a shared run.
DELETE FROM session_runs
WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM session_runs GROUP BY run_id
);
CREATE UNIQUE INDEX session_runs_one_session_per_run ON session_runs(run_id);

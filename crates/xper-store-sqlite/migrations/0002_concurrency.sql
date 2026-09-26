-- Operational ownership is separate from the event log and rebuilt projections.
-- It lets independent bridge processes share one project database safely.
CREATE TABLE coordinator_leases (
    coordinator_id TEXT PRIMARY KEY,
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0)
);
CREATE TABLE active_attempt_owners (
    attempt_id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL UNIQUE,
    coordinator_id TEXT NOT NULL
);
CREATE INDEX active_attempt_owners_by_coordinator ON active_attempt_owners(coordinator_id);
CREATE TABLE session_runs (
    session_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL
);

-- The old workflow event log and projections remain available for inspection.
-- New observations have an extensible envelope and never update legacy state.
CREATE TABLE recording_runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_sequence INTEGER NOT NULL DEFAULT 0,
    projection_json TEXT CHECK (projection_json IS NULL OR json_valid(projection_json))
);
CREATE INDEX recording_runs_by_session ON recording_runs(session_id, created_sequence);
CREATE TABLE recorded_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL REFERENCES recording_runs(run_id),
    event_type TEXT NOT NULL,
    occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
    event_json TEXT NOT NULL CHECK (json_valid(event_json))
);
CREATE INDEX recorded_events_by_run ON recorded_events(run_id, sequence);

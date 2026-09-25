CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
    event_json TEXT NOT NULL CHECK (json_valid(event_json))
);
CREATE INDEX events_by_run ON events(run_id, sequence);

CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    adapter TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
    current_visit_id TEXT,
    projection_json TEXT NOT NULL CHECK (json_valid(projection_json))
);
CREATE TABLE phase_visits (
    visit_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    phase TEXT NOT NULL,
    visit_number INTEGER NOT NULL CHECK (visit_number > 0),
    entered_at_ms INTEGER NOT NULL,
    exited_at_ms INTEGER,
    exit_gate_id TEXT,
    UNIQUE(run_id, phase, visit_number)
);
CREATE TABLE assignments (
    assignment_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    visit_id TEXT NOT NULL REFERENCES phase_visits(visit_id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    outcome TEXT
);
CREATE TABLE attempts (
    attempt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id) ON DELETE CASCADE,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    outcome TEXT
);
CREATE INDEX attempts_by_assignment ON attempts(assignment_id);

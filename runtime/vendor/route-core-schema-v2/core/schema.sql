-- Generic fresh SQLite schema; normalized schema metadata only.
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT,
  status TEXT,
  day_type TEXT,
  notes TEXT,
  last_exercise TEXT,
  last_set_id INTEGER,
  main_press_variant TEXT,
  active_superset_group TEXT,
  active_superset_exercises_json TEXT,
  active_superset_next_idx INTEGER
, identity_source TEXT, external_user_id TEXT);

CREATE INDEX idx_sessions_identity_user_started
  ON sessions(identity_source, external_user_id, started_at DESC);

CREATE TABLE sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  exercise TEXT,
  weight REAL,
  reps INTEGER,
  rpe REAL,
  notes TEXT,
  superset_group TEXT,
  created_at TEXT
, exercise_canonical TEXT, measurement_type TEXT NOT NULL DEFAULT 'reps', duration_seconds REAL, identity_source TEXT, external_user_id TEXT);

CREATE INDEX idx_sets_identity_user_session
  ON sets(identity_source, external_user_id, session_id);

CREATE INDEX idx_sets_measurement_type ON sets(measurement_type);

CREATE INDEX idx_sets_session_canonical ON sets(session_id, exercise_canonical);

CREATE TABLE cardio_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'cardio',
  mode TEXT NOT NULL,
  minutes REAL NOT NULL,
  distance_miles REAL,
  calories_burned REAL,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'chat',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, identity_source TEXT, external_user_id TEXT);

CREATE INDEX idx_cardio_blocks_identity_user_created
  ON cardio_blocks(identity_source, external_user_id, created_at DESC);

CREATE UNIQUE INDEX idx_cardio_blocks_dedupe
  ON cardio_blocks(session_id, phase, mode, created_at, minutes);

CREATE INDEX idx_cardio_blocks_session_phase_created
  ON cardio_blocks(session_id, phase, created_at DESC);

CREATE TABLE supersets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  superset_group TEXT,
  exercises_json TEXT,
  created_at TEXT
, label TEXT, kind  TEXT NOT NULL DEFAULT 'superset'
                                       CHECK (kind IN ('superset','circuit')), identity_source TEXT, external_user_id TEXT);

CREATE INDEX idx_supersets_identity_user_session
  ON supersets(identity_source, external_user_id, session_id);

CREATE TABLE body_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT,
  session_id INTEGER,
  weight_lbs REAL,
  notes TEXT
, identity_source TEXT, external_user_id TEXT);

CREATE INDEX idx_body_metrics_identity_user_ts
  ON body_metrics(identity_source, external_user_id, timestamp DESC);

CREATE TABLE miniapp_write_receipts (
    identity_source TEXT NOT NULL, external_user_id TEXT NOT NULL,
    operation TEXT NOT NULL, client_key TEXT NOT NULL, row_id INTEGER NOT NULL,
    PRIMARY KEY(identity_source, external_user_id, operation, client_key)
  );

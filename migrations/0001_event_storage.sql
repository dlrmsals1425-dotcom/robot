-- SAFEBOT private event storage and login throttling.
-- Apply with the D1 binding named DB before enabling control-center login.

CREATE TABLE IF NOT EXISTS login_attempts (
  identity TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_updated_at
  ON login_attempts (updated_at);

CREATE TABLE IF NOT EXISTS safety_events (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (
    status IN ('emergency', 'recovered', 'false_positive', 'interrupted')
  ),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  duration_seconds REAL NOT NULL CHECK (
    duration_seconds >= 0 AND duration_seconds <= 30
  ),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  notification TEXT NOT NULL CHECK (
    notification IN ('sent', 'not_sent', 'permission_needed')
  ),
  people INTEGER,
  objects INTEGER,
  device_id TEXT,
  clip_key TEXT,
  clip_mime TEXT,
  clip_size INTEGER,
  poster_key TEXT,
  poster_mime TEXT,
  poster_size INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_safety_events_created_at
  ON safety_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_safety_events_expires_at
  ON safety_events (expires_at);

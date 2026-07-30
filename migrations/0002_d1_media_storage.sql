-- Store anonymized SAFEBOT event media inside D1.
-- Media is split into rows no larger than 1,000,000 bytes.

ALTER TABLE safety_events
  ADD COLUMN media_bytes INTEGER NOT NULL DEFAULT 0
  CHECK (media_bytes >= 0 AND media_bytes <= 13631488);

ALTER TABLE safety_events
  ADD COLUMN clip_sha256 TEXT
  CHECK (clip_sha256 IS NULL OR length(clip_sha256) = 64);

ALTER TABLE safety_events
  ADD COLUMN poster_sha256 TEXT
  CHECK (poster_sha256 IS NULL OR length(poster_sha256) = 64);

CREATE TABLE media_usage (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
    active_bytes >= 0 AND active_bytes <= 100000000
  ),
  updated_at INTEGER NOT NULL
);

INSERT INTO media_usage (singleton, active_bytes, updated_at)
VALUES (
  1,
  COALESCE((SELECT SUM(media_bytes) FROM safety_events), 0),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

CREATE TABLE event_media_chunks (
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('clip', 'poster')),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  bytes BLOB NOT NULL,
  byte_length INTEGER NOT NULL CHECK (
    byte_length >= 1
    AND byte_length <= 1000000
    AND byte_length = length(bytes)
  ),
  PRIMARY KEY (event_id, kind, chunk_index),
  FOREIGN KEY (event_id) REFERENCES safety_events(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TRIGGER safety_events_media_quota_before_insert
BEFORE INSERT ON safety_events
WHEN NEW.media_bytes > 0
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM media_usage
      WHERE singleton = 1
        AND active_bytes + NEW.media_bytes <= 100000000
    )
    THEN RAISE(ABORT, 'MEDIA_STORAGE_LIMIT_REACHED')
  END;

  UPDATE media_usage
  SET
    active_bytes = active_bytes + NEW.media_bytes,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE singleton = 1;
END;

CREATE TRIGGER safety_events_media_usage_after_delete
AFTER DELETE ON safety_events
WHEN OLD.media_bytes > 0
BEGIN
  UPDATE media_usage
  SET
    active_bytes = MAX(0, active_bytes - OLD.media_bytes),
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE singleton = 1;
END;

CREATE TRIGGER safety_events_media_bytes_immutable
BEFORE UPDATE OF media_bytes ON safety_events
WHEN NEW.media_bytes <> OLD.media_bytes
BEGIN
  SELECT RAISE(ABORT, 'MEDIA_BYTES_IMMUTABLE');
END;

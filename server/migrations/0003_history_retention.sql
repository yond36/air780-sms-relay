-- History policy and replay receipts are separate from deletable personal data.
-- Receipts deliberately have no TTL: an offline device can replay an old ID indefinitely.
CREATE TABLE history_retention_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  event_days INTEGER NOT NULL CHECK (event_days BETWEEN 1 AND 90),
  sms_days INTEGER NOT NULL CHECK (sms_days BETWEEN 1 AND 90),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE history_retention_revisions (
  revision INTEGER PRIMARY KEY,
  event_days INTEGER NOT NULL,
  sms_days INTEGER NOT NULL,
  cutover INTEGER NOT NULL
);
CREATE TABLE history_receipts (
  scope TEXT NOT NULL CHECK (scope IN ('events', 'sms')),
  receipt TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1)),
  PRIMARY KEY (scope, receipt)
) WITHOUT ROWID;

-- A monotonic insertion watermark pins previews even when two arrivals share a
-- timestamp. Legacy rows start at zero; all subsequent inserts get a fresh ID.
CREATE TABLE history_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
INSERT INTO history_sequence VALUES (1, 0);
ALTER TABLE relay_records ADD COLUMN history_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relay_records ADD COLUMN retention_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sms_messages ADD COLUMN history_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sms_messages ADD COLUMN retention_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sms_commands ADD COLUMN history_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sms_commands ADD COLUMN retention_revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER history_event_sequence AFTER INSERT ON relay_records
WHEN NEW.key GLOB 'events:*'
BEGIN
  UPDATE history_sequence SET value = value + 1 WHERE id = 1;
  UPDATE relay_records SET history_seq = (SELECT value FROM history_sequence WHERE id = 1) WHERE key = NEW.key;
END;
CREATE TRIGGER history_message_sequence AFTER INSERT ON sms_messages
BEGIN
  UPDATE history_sequence SET value = value + 1 WHERE id = 1;
  UPDATE sms_messages SET history_seq = (SELECT value FROM history_sequence WHERE id = 1) WHERE id = NEW.id;
END;
CREATE TRIGGER history_command_sequence AFTER INSERT ON sms_commands
BEGIN
  UPDATE history_sequence SET value = value + 1 WHERE id = 1;
  UPDATE sms_commands SET history_seq = (SELECT value FROM history_sequence WHERE id = 1) WHERE id = NEW.id;
END;
CREATE INDEX history_events_revision ON relay_records (retention_revision, key) WHERE key GLOB 'events:*';
CREATE INDEX history_messages_revision ON sms_messages (retention_revision, id);
CREATE INDEX history_commands_revision ON sms_commands (retention_revision, id) WHERE purged_at IS NULL;

-- Confirmation handles contain only a random ID, step and authenticated MAC.
-- The scoped selection and per-step response live server-side for exact retries.
CREATE TABLE history_cleanup_previews (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('events', 'sms')),
  mode TEXT NOT NULL CHECK (mode IN ('expired', 'before', 'all')),
  device_id TEXT NOT NULL,
  cutoff TEXT NOT NULL,
  cutoff_seconds INTEGER NOT NULL,
  max_received TEXT NOT NULL,
  max_sequence INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  step INTEGER NOT NULL DEFAULT 0,
  cursor TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;
CREATE INDEX history_previews_expiry ON history_cleanup_previews (expires_at, id);
CREATE TABLE history_cleanup_batches (
  preview_id TEXT NOT NULL REFERENCES history_cleanup_previews(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  owner TEXT NOT NULL,
  result TEXT,
  PRIMARY KEY (preview_id, step)
) WITHOUT ROWID;
CREATE TABLE history_cleanup_targets (
  preview_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  history_seq INTEGER NOT NULL,
  receipt TEXT,
  eligible INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (preview_id, step, item_id),
  FOREIGN KEY (preview_id, step) REFERENCES history_cleanup_batches(preview_id, step) ON DELETE CASCADE
) WITHOUT ROWID;

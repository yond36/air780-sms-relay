PRAGMA foreign_keys = ON;

-- JSON business records retain their existing keys and sealed channel configuration.
CREATE TABLE IF NOT EXISTS relay_records (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS relay_records_expiry
  ON relay_records (expires_at, key) WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS relay_events_received
  ON relay_records (json_extract(value, '$.received_at') DESC, key DESC)
  WHERE key GLOB 'events:*' AND json_valid(value);
CREATE INDEX IF NOT EXISTS relay_events_device_received
  ON relay_records (json_extract(value, '$.device_id'), json_extract(value, '$.received_at') DESC, key DESC)
  WHERE key GLOB 'events:*' AND json_valid(value);
CREATE INDEX IF NOT EXISTS relay_events_type_received
  ON relay_records (json_extract(value, '$.type'), json_extract(value, '$.received_at') DESC, key DESC)
  WHERE key GLOB 'events:*' AND json_valid(value);
CREATE INDEX IF NOT EXISTS relay_events_device_type_received
  ON relay_records (json_extract(value, '$.device_id'), json_extract(value, '$.type'), json_extract(value, '$.received_at') DESC, key DESC)
  WHERE key GLOB 'events:*' AND json_valid(value);

-- The registry, not a Durable Object or its public mirror, owns device credentials.
CREATE TABLE IF NOT EXISTS device_registry (
  id TEXT PRIMARY KEY,
  device_json TEXT NOT NULL CHECK (json_valid(device_json)),
  token_hash TEXT,
  revoked_hash TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  credential_version INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sms_commands (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  credential_version INTEGER NOT NULL,
  peer TEXT NOT NULL,
  content TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  reply_to TEXT,
  encoding TEXT NOT NULL CHECK (encoding IN ('gsm7', 'ucs2')),
  segments INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'dispatched', 'submitted', 'failed', 'unknown', 'expired', 'cancelled')),
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  result_at TEXT,
  error TEXT,
  expires_at INTEGER NOT NULL,
  retention_expires_at INTEGER NOT NULL,
  purged_at INTEGER
);

CREATE INDEX IF NOT EXISTS sms_commands_device_queue
  ON sms_commands (device_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS sms_commands_device_rate
  ON sms_commands (device_id, created_at);
CREATE INDEX IF NOT EXISTS sms_commands_expiry
  ON sms_commands (expires_at, id) WHERE status IN ('queued', 'dispatched');
CREATE INDEX IF NOT EXISTS sms_commands_retention
  ON sms_commands (retention_expires_at, id) WHERE purged_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sms_commands_one_dispatched
  ON sms_commands (device_id) WHERE status = 'dispatched';

CREATE TABLE IF NOT EXISTS sms_messages (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  event_id TEXT,
  command_id TEXT REFERENCES sms_commands(id),
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  peer TEXT NOT NULL,
  content TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  sim_slot INTEGER,
  sms_time TEXT,
  send_status TEXT NOT NULL CHECK (send_status IN ('received', 'queued', 'dispatched', 'submitted', 'failed', 'unknown', 'expired', 'cancelled')),
  reply_to TEXT,
  expires_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_event
  ON sms_messages (device_id, event_id) WHERE direction = 'incoming';
CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_command
  ON sms_messages (command_id) WHERE command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_messages_time
  ON sms_messages (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sms_messages_device_time
  ON sms_messages (device_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sms_messages_direction_time
  ON sms_messages (direction, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sms_messages_status_time
  ON sms_messages (send_status, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sms_messages_expiry
  ON sms_messages (expires_at, id);

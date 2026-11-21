-- NULL SMS retention means permanent; event retention and command execution TTLs
-- stay finite. The migration runner supplies the transaction. Keep foreign keys
-- enabled: copy the child against the new parent, then drop the old child first.
CREATE TABLE history_retention_policy_0004 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  event_days INTEGER NOT NULL CHECK (event_days BETWEEN 1 AND 90),
  sms_days INTEGER CHECK (sms_days BETWEEN 1 AND 90),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
);
INSERT INTO history_retention_policy_0004 (id, event_days, sms_days, revision, updated_at)
  SELECT id, event_days, sms_days, revision, updated_at FROM history_retention_policy;
DROP TABLE history_retention_policy;
ALTER TABLE history_retention_policy_0004 RENAME TO history_retention_policy;

CREATE TABLE history_retention_revisions_0004 (
  revision INTEGER PRIMARY KEY,
  event_days INTEGER NOT NULL,
  sms_days INTEGER,
  cutover INTEGER NOT NULL
);
INSERT INTO history_retention_revisions_0004 (revision, event_days, sms_days, cutover)
  SELECT revision, event_days, sms_days, cutover FROM history_retention_revisions;
DROP TABLE history_retention_revisions;
ALTER TABLE history_retention_revisions_0004 RENAME TO history_retention_revisions;

CREATE TABLE sms_commands_0004 (
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
  retention_expires_at INTEGER,
  purged_at INTEGER,
  dispatch_session TEXT,
  history_seq INTEGER NOT NULL DEFAULT 0,
  retention_revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sms_commands_0004 (rowid, id, request_id, request_fingerprint, message_id, device_id, device_name,
  credential_hash, credential_version, peer, content, command_digest, reply_to, encoding, segments,
  status, created_at, dispatched_at, result_at, error, expires_at, retention_expires_at, purged_at,
  dispatch_session, history_seq, retention_revision)
  SELECT rowid, id, request_id, request_fingerprint, message_id, device_id, device_name,
    credential_hash, credential_version, peer, content, command_digest, reply_to, encoding, segments,
    status, created_at, dispatched_at, result_at, error, expires_at, retention_expires_at, purged_at,
    dispatch_session, history_seq, retention_revision FROM sms_commands;

CREATE TABLE sms_messages_0004 (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  event_id TEXT,
  command_id TEXT REFERENCES sms_commands_0004(id),
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  peer TEXT NOT NULL,
  content TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  sim_slot INTEGER,
  sms_time TEXT,
  send_status TEXT NOT NULL CHECK (send_status IN ('received', 'queued', 'dispatched', 'submitted', 'failed', 'unknown', 'expired', 'cancelled')),
  reply_to TEXT,
  expires_at INTEGER,
  history_seq INTEGER NOT NULL DEFAULT 0,
  retention_revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sms_messages_0004 (rowid, id, device_id, device_name, event_id, command_id, direction,
  peer, content, occurred_at, received_at, sim_slot, sms_time, send_status, reply_to, expires_at,
  history_seq, retention_revision)
  SELECT rowid, id, device_id, device_name, event_id, command_id, direction,
    peer, content, occurred_at, received_at, sim_slot, sms_time, send_status, reply_to, expires_at,
    history_seq, retention_revision FROM sms_messages;

DROP TABLE sms_messages;
DROP TABLE sms_commands;
ALTER TABLE sms_commands_0004 RENAME TO sms_commands;
ALTER TABLE sms_messages_0004 RENAME TO sms_messages;

CREATE INDEX sms_commands_device_queue
  ON sms_commands (device_id, status, created_at, id);
CREATE INDEX sms_commands_device_rate
  ON sms_commands (device_id, created_at);
CREATE INDEX sms_commands_expiry
  ON sms_commands (expires_at, id) WHERE status IN ('queued', 'dispatched');
CREATE INDEX sms_commands_retention
  ON sms_commands (retention_expires_at, id) WHERE purged_at IS NULL;
CREATE UNIQUE INDEX sms_commands_one_dispatched
  ON sms_commands (device_id) WHERE status = 'dispatched';
CREATE INDEX history_commands_revision ON sms_commands (retention_revision, id) WHERE purged_at IS NULL;

CREATE UNIQUE INDEX sms_messages_event
  ON sms_messages (device_id, event_id) WHERE direction = 'incoming';
CREATE UNIQUE INDEX sms_messages_command
  ON sms_messages (command_id) WHERE command_id IS NOT NULL;
CREATE INDEX sms_messages_time
  ON sms_messages (occurred_at DESC, id DESC);
CREATE INDEX sms_messages_device_time
  ON sms_messages (device_id, occurred_at DESC, id DESC);
CREATE INDEX sms_messages_direction_time
  ON sms_messages (direction, occurred_at DESC, id DESC);
CREATE INDEX sms_messages_status_time
  ON sms_messages (send_status, occurred_at DESC, id DESC);
CREATE INDEX sms_messages_expiry
  ON sms_messages (expires_at, id);
CREATE INDEX history_messages_revision ON sms_messages (retention_revision, id);

-- Copies above deliberately run without insertion triggers so existing sequence
-- watermarks remain exact. Future arrivals resume the same global sequence.
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

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { splitMigrationSql } from "./helpers/migration-sql.js";
import { SQLiteD1 } from "./helpers/d1-sqlite.js";

test("trusted migration splitter preserves trigger bodies, quotes and comments", () => {
  const statements = splitMigrationSql(`
    -- a comment ; not a statement
    CREATE TABLE demo (id INTEGER PRIMARY KEY, value TEXT);
    INSERT INTO demo VALUES (1, 'a;b''c');
    /* BEGIN; END; */
    CREATE TRIGGER demo_update AFTER INSERT ON demo BEGIN
      UPDATE demo SET value = CASE WHEN id = 2 THEN 'new;value' ELSE value END WHERE id = NEW.id;
      UPDATE demo SET value = value || ';' WHERE id = NEW.id;
    END;
    INSERT INTO demo VALUES (2, 'original');
  `);
  assert.equal(statements.length, 4);
  const db = new DatabaseSync(":memory:");
  try {
    for (const sql of statements) db.exec(sql);
    assert.equal(db.prepare("SELECT value FROM demo WHERE id=1").get().value, "a;b'c");
    assert.equal(db.prepare("SELECT value FROM demo WHERE id=2").get().value, "new;value;");
    assert.throws(() => splitMigrationSql("CREATE TRIGGER x AFTER INSERT ON demo BEGIN UPDATE demo SET value='x';"));
    assert.throws(() => splitMigrationSql("SELECT 'unterminated"));
  } finally { db.close(); }
});

test("all approved migrations execute as split statements including history triggers", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter((value) => value.endsWith(".sql")).sort()) {
      for (const sql of splitMigrationSql(readFileSync(new URL(name, directory), "utf8"))) db.exec(sql);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'history_%_sequence'").get().count, 3);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { db.close(); }
});

test("0004 preserves populated history, FKs, indexes, sequence watermarks and finite execution TTLs", (t) => {
  const db = new SQLiteD1({ through: "0003_history_retention.sql" });
  t.after(() => db.close());
  db.sqlite.exec(`
    INSERT INTO history_retention_policy VALUES (1, 7, 30, 2, '2026-11-20T08:00:00.000Z');
    INSERT INTO history_retention_revisions VALUES (1, 3, 10, 1795000000), (2, 7, 30, 1795161600);
    INSERT INTO device_registry VALUES ('manual', '{"id":"manual","enabled":true}', 'local-hash', NULL, 1, 0, 9, 'local-session');
    INSERT INTO relay_records (key, value, expires_at, retention_revision)
      VALUES ('events:manual:legacy', '{"device_id":"manual","event_id":"legacy","received_at":"2026-11-20T08:00:00.000Z"}', 1795766400, 2),
        ('channels:keep', '{"sealed_config":"unchanged-local-value"}', NULL, 0);
    INSERT INTO history_receipts VALUES ('events', 'event-receipt', 'fingerprint', 0), ('sms', 'sms-receipt', '', 1);
    INSERT INTO history_cleanup_previews VALUES ('preview', 'sms', 'all', 'manual', 'cutoff', 1795161600, 'received', 500, 1795162500, 0, 'cursor');
    INSERT INTO history_cleanup_batches VALUES ('preview', 0, 'owner', NULL);
    INSERT INTO history_cleanup_targets VALUES ('preview', 0, 'target', 3, 'receipt', 1);
  `);
  const insertCommand = db.sqlite.prepare(`
    INSERT INTO sms_commands (id, request_id, request_fingerprint, message_id, device_id, device_name,
      credential_hash, credential_version, peer, content, command_digest, reply_to, encoding, segments,
      status, created_at, dispatched_at, result_at, error, expires_at, retention_expires_at, purged_at,
      dispatch_session, retention_revision)
    VALUES (?, ?, ?, ?, 'manual', 'legacy device', 'local-hash', 9, '10086', 'legacy content', 'digest',
      'incoming', 'ucs2', 2, ?, '2026-11-20T08:00:00.000Z', 'dispatch time', 'result time', 'legacy error',
      1795162200, 1797753600, ?, 'local-session', 2)
  `);
  for (const state of ["queued", "dispatched", "submitted", "failed", "unknown", "expired", "cancelled"]) {
    insertCommand.run(state, `request-${state}`, `fingerprint-${state}`, `message-${state}`, state, state === "cancelled" ? 1795161600 : null);
  }
  db.sqlite.exec(`
    INSERT INTO sms_messages (id, device_id, device_name, event_id, direction, peer, content,
      occurred_at, received_at, sim_slot, sms_time, send_status, expires_at, retention_revision)
      VALUES ('incoming', 'manual', 'legacy device', 'legacy', 'incoming', '10086', 'legacy incoming',
        '2026-11-20T08:00:00.000Z', '2026-11-20T08:00:00.000Z', 0, 'SMS time', 'received', 1797753600, 2);
    INSERT INTO sms_messages (id, device_id, device_name, command_id, direction, peer, content,
      occurred_at, received_at, send_status, reply_to, expires_at, retention_revision)
      SELECT message_id, device_id, device_name, id, 'outgoing', peer, content, created_at, created_at,
        status, reply_to, retention_expires_at, retention_revision FROM sms_commands WHERE purged_at IS NULL;
    UPDATE history_sequence SET value = 500 WHERE id = 1;
  `);
  const tables = db.rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(({ name }) => name);
  const data = () => Object.fromEntries(tables.map((name) => [name, db.rows(`SELECT * FROM ${name}`)]));
  const normalizeSql = (sql) => sql?.replace(/\bIF NOT EXISTS\s+/gi, "").replace(/"/g, "").replace(/\s+/g, " ").trim();
  const schema = () => db.rows("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .map((row) => ({ ...row, sql: normalizeSql(row.sql) }));
  const before = data();
  const beforeSchema = schema();
  const metadata = Object.fromEntries(tables.map((name) => [name, {
    columns: db.rows(`PRAGMA table_info(${name})`),
    foreignKeys: db.rows(`PRAGMA foreign_key_list(${name})`),
  }]));
  const rowids = db.rows("SELECT rowid, id FROM sms_commands ORDER BY rowid");

  // Force failure after policy copies and the new command table were created.
  // The fixture must roll back the entire migration, then permit a clean retry.
  db.sqlite.exec("CREATE TABLE sms_messages_0004 (marker TEXT)");
  const failedSchema = schema();
  assert.throws(() => db.migrate(), /already exists/);
  assert.deepEqual(data(), before);
  assert.deepEqual(schema(), failedSchema);
  db.sqlite.exec("DROP TABLE sms_messages_0004");
  db.migrate();
  assert.deepEqual(data(), before);
  assert.deepEqual(db.rows("SELECT rowid, id FROM sms_commands ORDER BY rowid"), rowids);
  for (const name of tables) {
    const nullable = name.startsWith("history_retention_") ? "sms_days"
      : name === "sms_commands" ? "retention_expires_at" : name === "sms_messages" ? "expires_at" : null;
    assert.deepEqual(db.rows(`PRAGMA table_info(${name})`), metadata[name].columns.map((column) =>
      column.name === nullable ? { ...column, notnull: 0 } : column));
    assert.deepEqual(db.rows(`PRAGMA foreign_key_list(${name})`), metadata[name].foreignKeys);
  }
  assert.deepEqual(schema().filter(({ type }) => type !== "table"), beforeSchema.filter(({ type }) => type !== "table"));
  assert.deepEqual(db.rows("PRAGMA foreign_key_check"), []);
  assert.equal(db.row("PRAGMA foreign_keys").foreign_keys, 1);
  db.migrate();
  assert.deepEqual(data(), before);

  db.sqlite.exec(`
    UPDATE history_retention_policy SET sms_days = NULL;
    INSERT INTO history_retention_revisions VALUES (3, 7, NULL, 1795161601), (4, 7, 5, 1795161602);
    UPDATE sms_commands SET retention_expires_at = NULL;
    UPDATE sms_messages SET expires_at = NULL;
  `);
  assert.equal(db.row("SELECT sms_days FROM history_retention_policy").sms_days, null);
  assert.deepEqual(db.rows("SELECT sms_days FROM history_retention_revisions ORDER BY revision").map(({ sms_days }) => sms_days), [10, 30, null, 5]);
  assert.throws(() => db.sqlite.exec("UPDATE history_retention_policy SET event_days = NULL"), /NOT NULL/);
  assert.throws(() => db.sqlite.exec("UPDATE history_retention_policy SET event_days = 0"), /CHECK constraint/);
  assert.throws(() => db.sqlite.exec("UPDATE history_retention_policy SET event_days = 91"), /CHECK constraint/);
  // Zero is the API sentinel only; D1 still requires NULL for permanent SMS.
  assert.throws(() => db.sqlite.exec("UPDATE history_retention_policy SET sms_days = 0"), /CHECK constraint/);
  assert.throws(() => db.sqlite.exec("UPDATE history_retention_policy SET sms_days = 91"), /CHECK constraint/);
  assert.throws(() => db.sqlite.exec("UPDATE sms_commands SET expires_at = NULL"), /NOT NULL/);
  assert.throws(() => db.sqlite.exec("UPDATE sms_commands SET status = 'dispatched' WHERE id = 'queued'"), /UNIQUE constraint/);
  assert.throws(() => db.sqlite.exec("UPDATE sms_commands SET request_id = 'request-queued' WHERE id = 'submitted'"), /UNIQUE constraint/);
  assert.throws(() => db.sqlite.exec("UPDATE sms_messages SET command_id = 'missing' WHERE id = 'message-queued'"), /FOREIGN KEY constraint/);
  assert.throws(() => db.sqlite.exec("DELETE FROM sms_commands WHERE id = 'queued'"), /FOREIGN KEY constraint/);
  db.sqlite.exec(`
    INSERT INTO relay_records (key, value) VALUES ('events:manual:new', '{}');
    INSERT INTO sms_commands SELECT 'new-command', 'new-request', request_fingerprint, 'new-message', device_id,
      device_name, credential_hash, credential_version, peer, content, command_digest, reply_to, encoding, segments,
      'queued', created_at, dispatched_at, result_at, error, expires_at, NULL, NULL, dispatch_session, 0, 0
      FROM sms_commands WHERE id = 'queued';
    INSERT INTO sms_messages (id, device_id, device_name, command_id, direction, peer, content,
      occurred_at, received_at, send_status, expires_at)
      SELECT message_id, device_id, device_name, id, 'outgoing', peer, content, created_at, created_at, status, NULL
      FROM sms_commands WHERE id = 'new-command';
  `);
  assert.equal(db.row("SELECT history_seq FROM relay_records WHERE key = 'events:manual:new'").history_seq, 501);
  assert.deepEqual(db.row("SELECT history_seq, expires_at, retention_expires_at FROM sms_commands WHERE id = 'new-command'"), {
    history_seq: 502, expires_at: 1795162200, retention_expires_at: null,
  });
  assert.deepEqual(db.row("SELECT history_seq, expires_at FROM sms_messages WHERE id = 'new-message'"), { history_seq: 503, expires_at: null });
  assert.equal(db.row("SELECT value FROM history_sequence").value, 503);
  assert.deepEqual(db.rows("PRAGMA foreign_key_check"), []);
});

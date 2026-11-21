import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { splitMigrationSql } from "./migration-sql.js";

// Only these repository migrations can be loaded; no caller-supplied file paths
// or directory entries are executed by the local SQL fixture.
const migrationNames = ["0001_d1.sql", "0002_ws_command_sessions.sql", "0003_history_retention.sql", "0004_permanent_sms.sql"];
const migrationDirectory = new URL("../../migrations/", import.meta.url);

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) {
    if (params.length > 100) throw new Error("D1 has a 100-bound-parameter limit");
    if (params.some((value) => value === undefined)) throw new Error("D1 cannot bind undefined");
    return new Statement(this.db, this.sql, params);
  }
  async all() { return this.db.enqueue(() => this.db.execute(this)); }
  async run() { return this.db.enqueue(() => this.db.execute(this)); }
  async first(column) {
    const result = await this.all();
    const row = result.results[0];
    return row ? column === undefined ? row : row[column] : null;
  }
}

// Real SQLite SQL, constraints, RETURNING and transactions, with the native D1 API surface.
// The queue models D1's serialization of concurrent writes while callers can race their reads.
export class SQLiteD1 {
  constructor({ through = migrationNames.at(-1) } = {}) {
    if (!migrationNames.includes(through)) throw new Error("Unknown fixture migration");
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sessions = [];
    this.previous = Promise.resolve();
    this.migrationIndex = -1;
    this.migrate(through);
  }

  migrate(through = migrationNames.at(-1)) {
    const last = migrationNames.indexOf(through);
    if (last < 0) throw new Error("Unknown fixture migration");
    for (let index = this.migrationIndex + 1; index <= last; index++) {
      const sql = readFileSync(new URL(migrationNames[index], migrationDirectory), "utf8");
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of splitMigrationSql(sql)) this.sqlite.exec(statement);
        this.sqlite.exec("COMMIT");
        this.migrationIndex = index;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  }

  prepare(sql) { return new Statement(this, sql); }

  withSession(mode) {
    this.sessions.push(mode);
    return { prepare: (sql) => this.prepare(sql), batch: (statements) => this.batch(statements), getBookmark: () => "local-test-bookmark" };
  }

  enqueue(action) {
    const task = this.previous.then(action);
    this.previous = task.catch(() => {});
    return task;
  }

  execute(statement) {
    if (this.failSql?.(statement.sql, statement.params)) throw new Error("simulated D1 statement failure");
    const compiled = this.sqlite.prepare(statement.sql);
    const beforeChanges = Number(this.sqlite.prepare("SELECT total_changes() AS n").get().n);
    let results = [];
    let changes = 0;
    if (compiled.columns().length) {
      results = compiled.all(...statement.params).map((row) => ({ ...row }));
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement.sql)) changes = Number(this.sqlite.prepare("SELECT changes() AS n").get().n);
    } else {
      changes = Number(compiled.run(...statement.params).changes);
    }
    // Native D1 includes trigger/cascade side effects in meta.changes. Tests
    // must not accidentally treat that count as an INSERT's affected row count.
    changes = Number(this.sqlite.prepare("SELECT total_changes() AS n").get().n) - beforeChanges;
    return { success: true, results, meta: { changes } };
  }

  batch(statements) {
    return this.enqueue(() => {
      this.beforeBatch?.(statements);
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => this.execute(statement));
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    });
  }

  rows(sql, ...params) { return this.sqlite.prepare(sql).all(...params).map((row) => ({ ...row })); }
  row(sql, ...params) { const row = this.sqlite.prepare(sql).get(...params); return row ? { ...row } : null; }
  close() { this.sqlite.close(); }
}

export function d1Fixture(t, overrides = {}) {
  const db = new SQLiteD1();
  t.after(() => db.close());
  const env = { DB: db, ...overrides };
  return { db, env };
}

export function clock(t, time = "2026-11-20T08:00:00.000Z") {
  let current = Date.parse(time);
  t.mock.timers.enable({ apis: ["Date"], now: current });
  return {
    now: () => current,
    seconds: () => Math.floor(current / 1000),
    advance(milliseconds) { current += milliseconds; t.mock.timers.setTime(current); },
    set(time) { current = typeof time === "number" ? time : Date.parse(time); t.mock.timers.setTime(current); },
  };
}

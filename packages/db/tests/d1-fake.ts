// An in-memory D1 for tests: Node's built-in SQLite behind the slice of the
// D1 API this repo uses (prepare/bind/first/all/run, batch, exec), with the
// real migrations applied. D1 is SQLite, so the SQL under test is the SQL
// that ships — conflict targets, partial indexes, RETURNING and all.
//
// Loaded through createRequire so Vite never tries to resolve `node:sqlite`.

import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// D1 binds booleans as 1/0 and undefined as NULL; node:sqlite rejects both.
const norm = (v: unknown): unknown =>
  v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;

class FakeStatement {
  constructor(
    private readonly db: SqliteDb,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, params.map(norm));
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const rows = this.db.prepare(this.sql).all(...this.params);
    return { results: rows.map((r) => ({ ...r })) as T[], success: true, meta: {} };
  }
  async run(): Promise<{ success: true; results: []; meta: { changes: number } }> {
    const r = this.runSync();
    return { success: true, results: [], meta: { changes: r } };
  }
  runSync(): number {
    // A statement with RETURNING must be stepped through `all` to execute.
    if (/\bRETURNING\b/i.test(this.sql))
      return this.db.prepare(this.sql).all(...this.params).length;
    return Number(this.db.prepare(this.sql).run(...this.params).changes);
  }
}

export class FakeD1 {
  readonly sqlite: SqliteDb;
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
    for (const f of readdirSync(MIGRATIONS)
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      this.sqlite.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    }
  }
  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.sqlite, sql);
  }
  /** Like D1: all or nothing. */
  async batch(stmts: FakeStatement[]): Promise<unknown[]> {
    this.sqlite.exec('BEGIN');
    try {
      const out = stmts.map((s) => ({ success: true, meta: { changes: s.runSync() } }));
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql: string): Promise<{ count: number }> {
    this.sqlite.exec(sql);
    return { count: 1 };
  }
  /** Synchronous read for assertions. */
  rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.sqlite
      .prepare(sql)
      .all(...params.map(norm))
      .map((r) => ({ ...r }));
  }
}

/** A fresh database, typed as the D1Database the code under test expects. */
export function fakeD1(): FakeD1 & D1Database {
  return new FakeD1() as unknown as FakeD1 & D1Database;
}

/**
 * Minimal D1 facade over node:sqlite, for tests and local rebuilds that must
 * run the production SQL unchanged. Supports prepare/bind/all/first/run/batch.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Value = SQLInputValue;

function normalize(values: unknown[]): Value[] {
  return values.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value as Value;
  });
}

function returnsRows(sql: string): boolean {
  return /^\s*(?:select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);
}

class Statement {
  constructor(private readonly db: DatabaseSync, readonly sql: string, readonly params: Value[] = []) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, normalize(values));
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return this.allSync<T>();
  }

  allSync<T>(): { results: T[]; success: true; meta: Record<string, unknown> } {
    const statement = this.db.prepare(this.sql);
    if (returnsRows(this.sql)) {
      return { results: statement.all(...this.params) as T[], success: true, meta: {} };
    }
    const info = statement.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const rows = this.allSync<T>().results;
    return rows[0] ?? null;
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown>; results: unknown[] }> {
    return this.allSync();
  }
}

export class SqliteD1 {
  readonly sqlite: DatabaseSync;

  constructor(path = ":memory:") {
    this.sqlite = new DatabaseSync(path);
  }

  prepare(sql: string): Statement {
    return new Statement(this.sqlite, sql);
  }

  async batch(statements: Statement[]): Promise<Array<{ results: unknown[]; success: true; meta: Record<string, unknown> }>> {
    this.sqlite.exec("BEGIN");
    try {
      const out = statements.map((statement) => statement.allSync<unknown>());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string): Promise<void> {
    this.sqlite.exec(sql);
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

export function migratedDatabase(root = process.cwd()): SqliteD1 {
  const db = new SqliteD1();
  const dir = join(root, "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    db.sqlite.exec(readFileSync(join(dir, file), "utf8"));
  }
  return db;
}

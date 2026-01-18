import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const dbPath = "data/flatfinder.sqlite";

let db: DatabaseSync | null = null;

const runTransaction = (database: DatabaseSync, fn: () => void) => {
  database.exec("BEGIN");
  try {
    fn();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const getDb = () => {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      position INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, type, id)
    );
    CREATE INDEX IF NOT EXISTS idx_items_source_type_position
      ON items (source, type, position);
  `);
  return db;
};

export const getMeta = (key: string): string | null => {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
};

export const setMeta = (key: string, value: string) => {
  getDb()
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
};

export const getConfig = (key: string): string | null => {
  const row = getDb().prepare("SELECT value FROM config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
};

export const setConfig = (key: string, value: string) => {
  getDb()
    .prepare(
      "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
};

export const loadItems = <T>(source: string, type: string): T[] => {
  const rows = getDb()
    .prepare("SELECT json FROM items WHERE source = ? AND type = ? ORDER BY position ASC")
    .all(source, type) as Array<{ json: string }>;
  return rows.map((row) => JSON.parse(row.json) as T);
};

export const saveItems = <T extends { id?: string | null }>(
  source: string,
  type: string,
  items: T[],
  now: string,
) => {
  const database = getDb();
  const insert = database.prepare(
    "INSERT INTO items (source, type, id, json, position, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, type, id) DO UPDATE SET json = excluded.json, position = excluded.position, updated_at = excluded.updated_at",
  );

  runTransaction(database, () => {
    const ids: string[] = [];
    items.forEach((item, index) => {
      if (!item.id) return;
      ids.push(item.id);
      insert.run(source, type, item.id, JSON.stringify(item), index, now);
    });

    if (ids.length === 0) {
      database.prepare("DELETE FROM items WHERE source = ? AND type = ?").run(source, type);
      return;
    }

    const placeholders = ids.map(() => "?").join(",");
    database
      .prepare(`DELETE FROM items WHERE source = ? AND type = ? AND id NOT IN (${placeholders})`)
      .run(source, type, ...ids);
  });
};

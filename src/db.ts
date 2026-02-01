import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const dbPath = "data/flatfinder.sqlite";
const migrationKey = "schema.items.normalized.v1";
const dropPositionKey = "schema.items.drop_position.v1";

const itemColumnSpecs = [
  ["seen_at", "TEXT"],
  ["hidden_at", "TEXT"],
  ["interest_requested_at", "TEXT"],
  ["interest_rank", "INTEGER"],
  ["interest_locked", "INTEGER"],
  ["interest_watch_next_at", "TEXT"],
  ["interest_watch_last_at", "TEXT"],
  ["flags_angemeldet", "INTEGER"],
  ["telegram_notified_at", "TEXT"],
  ["first_seen_at", "TEXT"],
  ["last_seen_at", "TEXT"],
] as const;

type ItemColumn = (typeof itemColumnSpecs)[number][0];

export type ItemRow = {
  json: string;
  seen_at: string | null;
  hidden_at: string | null;
  interest_requested_at: string | null;
  interest_rank: number | null;
  interest_locked: number | null;
  interest_watch_next_at: string | null;
  interest_watch_last_at: string | null;
  flags_angemeldet: number | null;
  telegram_notified_at: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  updated_at: string;
};

export type ItemColumnValues = Partial<Record<ItemColumn, string | number | null>>;

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

const ensureSchema = (database: DatabaseSync) => {
  database.exec(`
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
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, type, id)
    );
    CREATE INDEX IF NOT EXISTS idx_items_source_type_updated
      ON items (source, type, updated_at);
  `);

  const existing = new Set(
    database
      .prepare("PRAGMA table_info(items)")
      .all()
      .map((row) => (row as { name: string }).name),
  );

  itemColumnSpecs.forEach(([name, type]) => {
    if (existing.has(name)) return;
    database.exec(`ALTER TABLE items ADD COLUMN ${name} ${type}`);
  });

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_items_source_type_first_seen
      ON items (source, type, first_seen_at);
  `);
};

const parseBoolean = (value: unknown) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return null;
};

const toBooleanInt = (value: unknown) => {
  const parsed = parseBoolean(value);
  return parsed === null ? null : parsed ? 1 : 0;
};

const migrateItemColumns = (database: DatabaseSync) => {
  const existing = database.prepare("SELECT value FROM meta WHERE key = ?").get(migrationKey) as
    | { value: string }
    | undefined;
  if (existing?.value === "1") return;

  const rows = database
    .prepare(
      `SELECT source, type, id, json, updated_at,
        seen_at, hidden_at,
        interest_requested_at, interest_rank, interest_locked,
        interest_watch_next_at, interest_watch_last_at,
        flags_angemeldet, telegram_notified_at,
        first_seen_at, last_seen_at
      FROM items`,
    )
    .all() as Array<ItemRow & { source: string; type: string; id: string }>;

  const update = database.prepare(
    `UPDATE items SET
      seen_at = ?,
      hidden_at = ?,
      interest_requested_at = ?,
      interest_rank = ?,
      interest_locked = ?,
      interest_watch_next_at = ?,
      interest_watch_last_at = ?,
      flags_angemeldet = ?,
      telegram_notified_at = ?,
      first_seen_at = ?,
      last_seen_at = ?
      WHERE source = ? AND type = ? AND id = ?`,
  );

  runTransaction(database, () => {
    rows.forEach((row) => {
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(row.json) as Record<string, unknown>;
      } catch {
        json = {};
      }

      const interest = (json.interest ?? {}) as Record<string, unknown>;
      const watch = (interest.watch ?? {}) as Record<string, unknown>;
      const flags = (json.flags ?? {}) as Record<string, unknown>;

      const seenAt = row.seen_at ?? (json.seenAt as string | null) ?? null;
      const hiddenAt = row.hidden_at ?? (json.hiddenAt as string | null) ?? null;
      const interestRequestedAt =
        row.interest_requested_at ?? (interest.requestedAt as string | null) ?? null;
      const interestRank = row.interest_rank ?? (interest.rank as number | null) ?? null;
      const interestLocked = row.interest_locked ?? toBooleanInt(interest.locked ?? null);
      const interestWatchNextAt =
        row.interest_watch_next_at ?? (watch.nextCheckAt as string | null) ?? null;
      const interestWatchLastAt =
        row.interest_watch_last_at ?? (watch.lastCheckAt as string | null) ?? null;
      const flagsAngemeldet = row.flags_angemeldet ?? toBooleanInt(flags.angemeldet ?? null);
      const telegramNotifiedAt =
        row.telegram_notified_at ?? (json.telegramNotifiedAt as string | null) ?? null;
      const firstSeenAt =
        row.first_seen_at ?? (json.firstSeenAt as string | null) ?? row.updated_at ?? null;
      const lastSeenAt =
        row.last_seen_at ?? (json.lastSeenAt as string | null) ?? row.updated_at ?? null;

      update.run(
        seenAt,
        hiddenAt,
        interestRequestedAt,
        interestRank,
        interestLocked,
        interestWatchNextAt,
        interestWatchLastAt,
        flagsAngemeldet,
        telegramNotifiedAt,
        firstSeenAt,
        lastSeenAt,
        row.source,
        row.type,
        row.id,
      );
    });

    database
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(migrationKey, "1");
  });
};

const migrateDropPosition = (database: DatabaseSync) => {
  const existing = database.prepare("SELECT value FROM meta WHERE key = ?").get(dropPositionKey) as
    | { value: string }
    | undefined;
  if (existing?.value === "1") return;

  const columns = database
    .prepare("PRAGMA table_info(items)")
    .all()
    .map((row) => (row as { name: string }).name);
  if (!columns.includes("position")) {
    database
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(dropPositionKey, "1");
    return;
  }

  runTransaction(database, () => {
    database.exec(`
      CREATE TABLE items_new (
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        seen_at TEXT,
        hidden_at TEXT,
        interest_requested_at TEXT,
        interest_rank INTEGER,
        interest_locked INTEGER,
        interest_watch_next_at TEXT,
        interest_watch_last_at TEXT,
        flags_angemeldet INTEGER,
        telegram_notified_at TEXT,
        first_seen_at TEXT,
        last_seen_at TEXT,
        PRIMARY KEY (source, type, id)
      );
    `);

    database.exec(`
      INSERT INTO items_new (
        source,
        type,
        id,
        json,
        updated_at,
        seen_at,
        hidden_at,
        interest_requested_at,
        interest_rank,
        interest_locked,
        interest_watch_next_at,
        interest_watch_last_at,
        flags_angemeldet,
        telegram_notified_at,
        first_seen_at,
        last_seen_at
      )
      SELECT
        source,
        type,
        id,
        json,
        updated_at,
        seen_at,
        hidden_at,
        interest_requested_at,
        interest_rank,
        interest_locked,
        interest_watch_next_at,
        interest_watch_last_at,
        flags_angemeldet,
        telegram_notified_at,
        first_seen_at,
        last_seen_at
      FROM items;
    `);

    database.exec("DROP TABLE items;");
    database.exec("ALTER TABLE items_new RENAME TO items;");
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_items_source_type_updated
        ON items (source, type, updated_at);
      CREATE INDEX IF NOT EXISTS idx_items_source_type_first_seen
        ON items (source, type, first_seen_at);
    `);

    database
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(dropPositionKey, "1");
  });
};

export const getDb = () => {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  ensureSchema(db);
  migrateItemColumns(db);
  migrateDropPosition(db);
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

const mergeInterest = (row: ItemRow) => {
  const requestedAt = row.interest_requested_at ?? null;
  const rank = row.interest_rank ?? null;
  const lockedRaw = row.interest_locked;
  const locked = lockedRaw === null ? null : lockedRaw === 1;
  const watchNextAt = row.interest_watch_next_at ?? null;
  const watchLastAt = row.interest_watch_last_at ?? null;

  if (!requestedAt && rank === null && locked === null && !watchNextAt && !watchLastAt) {
    return undefined;
  }

  const watch =
    watchNextAt || watchLastAt
      ? {
          nextCheckAt: watchNextAt ?? null,
          lastCheckAt: watchLastAt ?? null,
        }
      : undefined;

  return {
    requestedAt,
    rank,
    locked,
    watch,
  };
};

const mergeItemRow = <T>(row: ItemRow) => {
  const item = JSON.parse(row.json) as T & {
    interest?: {
      requestedAt?: string | null;
      rank?: number | null;
      locked?: boolean | null;
      watch?: { nextCheckAt?: string | null; lastCheckAt?: string | null } | null;
    };
    flags?: { angemeldet?: boolean };
    seenAt?: string | null;
    hiddenAt?: string | null;
    telegramNotifiedAt?: string | null;
    firstSeenAt?: string | null;
    lastSeenAt?: string | null;
  };

  const interest = mergeInterest(row);
  if (interest) {
    item.interest = interest;
  } else {
    delete item.interest;
  }

  const flags = item.flags ?? {};
  if (row.flags_angemeldet !== null) {
    flags.angemeldet = row.flags_angemeldet === 1;
  }
  item.flags = flags;

  item.seenAt = row.seen_at ?? null;
  item.hiddenAt = row.hidden_at ?? null;
  item.telegramNotifiedAt = row.telegram_notified_at ?? null;
  item.firstSeenAt = row.first_seen_at ?? row.updated_at ?? null;
  item.lastSeenAt = row.last_seen_at ?? null;

  return item as T;
};

export const loadItems = <T>(source: string, type: string): T[] => {
  const rows = getDb()
    .prepare(
      `SELECT json,
        seen_at, hidden_at,
        interest_requested_at, interest_rank, interest_locked,
        interest_watch_next_at, interest_watch_last_at,
        flags_angemeldet, telegram_notified_at,
        first_seen_at, last_seen_at,
        updated_at
      FROM items
      WHERE source = ? AND type = ?
      ORDER BY COALESCE(first_seen_at, updated_at) DESC, id DESC`,
    )
    .all(source, type) as ItemRow[];
  return rows.map((row) => mergeItemRow<T>(row));
};

export const loadItem = <T>(source: string, type: string, id: string): T | null => {
  const row = getDb()
    .prepare(
      `SELECT json,
        seen_at, hidden_at,
        interest_requested_at, interest_rank, interest_locked,
        interest_watch_next_at, interest_watch_last_at,
        flags_angemeldet, telegram_notified_at,
        first_seen_at, last_seen_at,
        updated_at
      FROM items
      WHERE source = ? AND type = ? AND id = ?`,
    )
    .get(source, type, id) as ItemRow | undefined;
  if (!row) return null;
  return mergeItemRow<T>(row);
};

const stripDynamicFields = <T extends Record<string, unknown>>(item: T) => {
  const {
    seenAt: _seenAt,
    hiddenAt: _hiddenAt,
    interest: _interest,
    telegramNotifiedAt: _telegramNotifiedAt,
    firstSeenAt: _firstSeenAt,
    lastSeenAt: _lastSeenAt,
    ...rest
  } = item as Record<string, unknown>;
  return rest as T;
};

export const saveScrapedItems = <
  T extends {
    id?: string | null;
    flags?: { angemeldet?: boolean } | null;
    firstSeenAt?: string | null;
    lastSeenAt?: string | null;
  },
>(
  source: string,
  type: string,
  items: T[],
  now: string,
  options?: { deleteMissing?: boolean },
) => {
  const database = getDb();
  const insert = database.prepare(
    `INSERT INTO items (
      source,
      type,
      id,
      json,
      updated_at,
      seen_at,
      hidden_at,
      flags_angemeldet,
      first_seen_at,
      last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, type, id) DO UPDATE SET
      json = excluded.json,
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at,
      flags_angemeldet = excluded.flags_angemeldet,
      first_seen_at = COALESCE(items.first_seen_at, excluded.first_seen_at)`,
  );

  runTransaction(database, () => {
    const ids: string[] = [];
    items.forEach((item) => {
      if (!item.id) return;
      ids.push(item.id);
      const payload = stripDynamicFields(item);
      const firstSeenAt = item.firstSeenAt ?? now;
      const lastSeenAt = item.lastSeenAt ?? now;
      insert.run(
        source,
        type,
        item.id,
        JSON.stringify(payload),
        now,
        (item as { seenAt?: string | null }).seenAt ?? null,
        (item as { hiddenAt?: string | null }).hiddenAt ?? null,
        toBooleanInt(item.flags?.angemeldet ?? null),
        firstSeenAt,
        lastSeenAt,
      );
    });

    if (options?.deleteMissing === false) {
      return;
    }

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

const buildUpdateStatement = (keys: ItemColumn[]) => {
  const validKeys = keys.filter((key) => itemColumnSpecs.some(([name]) => name === key));
  if (validKeys.length === 0) return null;
  const assignments = validKeys.map((key) => `${key} = ?`).join(", ");
  return {
    keys: validKeys,
    sql: `UPDATE items SET ${assignments}, updated_at = ? WHERE source = ? AND type = ? AND id = ?`,
  };
};

export const updateItemColumns = (
  source: string,
  type: string,
  id: string,
  columns: ItemColumnValues,
  now: string,
) => {
  const keys = Object.keys(columns) as ItemColumn[];
  const statement = buildUpdateStatement(keys);
  if (!statement) return;
  const values = statement.keys.map((key) => columns[key] ?? null);
  getDb()
    .prepare(statement.sql)
    .run(...values, now, source, type, id);
};

export const updateItemsColumns = (
  source: string,
  type: string,
  keys: ItemColumn[],
  updates: Array<{ id: string; values: Array<string | number | null> }>,
  now: string,
) => {
  const statement = buildUpdateStatement(keys);
  if (!statement || updates.length === 0) return;
  const database = getDb();
  const prepared = database.prepare(statement.sql);
  runTransaction(database, () => {
    updates.forEach((update) => {
      const values = update.values.map((value) => value ?? null);
      prepared.run(...values, now, source, type, update.id);
    });
  });
};

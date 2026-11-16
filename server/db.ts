// PostgreSQL storage with node-postgres. The schema lives in SQL migrations (see migrate.ts).
//
// Queries use one(), all() and run(). Inside tx(), the same helpers automatically use the
// transaction's client (tracked with AsyncLocalStorage), so code like event() or setStatus()
// works both on its own and as part of a transaction.
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';

// Return BIGINT (COUNT(*), epoch-ms columns, identity ids) and NUMERIC (AVG) as JS numbers.
// All values used here are far below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
// Timestamps are returned as 'YYYY-MM-DD HH:MM:SS' in UTC, the same format the API has always used.
// Converted here (not with a session TimeZone setting) so it also works through poolers like Neon's.
export function utcTimestamp(v: string): string {
  const d = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 19).replace('T', ' ');
}
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, utcTimestamp);

/**
 * Accepts connection strings as hosted providers (Neon, Supabase, Render…) give them:
 * - sslmode=require/prefer/verify-ca: node-postgres already treats these as verify-full (certificate
 *   checked); this says so explicitly, which also silences pg's deprecation warning.
 * - channel_binding=require: libpq-only parameter; mapped to pg's enableChannelBinding.
 */
export function connectionConfig(connectionString: string): pg.PoolConfig {
  let url: URL;
  try { url = new URL(connectionString); } catch { return { connectionString }; }
  const q = url.searchParams;
  const channelBinding = q.get('channel_binding');
  q.delete('channel_binding');
  if (['require', 'prefer', 'verify-ca'].includes(q.get('sslmode') || '') && !q.has('uselibpqcompat')) q.set('sslmode', 'verify-full');
  return { connectionString: url.toString(), ...(channelBinding === 'require' ? { enableChannelBinding: true } : {}) };
}

export type Param = unknown;
type Queryable = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;
const txClient = new AsyncLocalStorage<pg.PoolClient>();

export interface DbOptions {
  connectionString?: string;
  /** Postgres schema to use (search_path). Empty means the default (public). */
  schema?: string;
  max?: number;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function openDb(opts: DbOptions = {}): pg.Pool {
  const schema = opts.schema ?? config.databaseSchema;
  if (schema && !SCHEMA_NAME.test(schema)) throw new Error(`Invalid DATABASE_SCHEMA: ${schema}`);
  pool = new pg.Pool({
    ...connectionConfig(opts.connectionString ?? config.databaseUrl),
    max: opts.max ?? config.databasePoolMax,
    connectionTimeoutMillis: 15_000, // Neon computes that were suspended take a moment to wake up
    ...(config.databaseSsl ? { ssl: { rejectUnauthorized: true } } : {}),
    // Only the tests set a schema. Use a direct (non-pooled) connection string for them.
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  return pool;
}

export function getPool(): pg.Pool {
  return pool ?? openDb();
}

export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end();
}

const q = (): Queryable => txClient.getStore() ?? getPool();

export async function one<T = Record<string, any>>(sql: string, ...params: Param[]): Promise<T | undefined> {
  return (await q().query(sql, params)).rows[0] as T | undefined;
}
export async function all<T = Record<string, any>>(sql: string, ...params: Param[]): Promise<T[]> {
  return (await q().query(sql, params)).rows as T[];
}
export async function run(sql: string, ...params: Param[]): Promise<{ changes: number }> {
  const r = await q().query(sql, params);
  return { changes: r.rowCount ?? 0 };
}

/** Runs fn in a transaction. Nested calls join the outer transaction. */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (txClient.getStore()) return fn();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await txClient.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const r = await one<{ value: string }>('SELECT value FROM settings WHERE key = $1', key);
  return r ? (JSON.parse(r.value) as T) : fallback;
}
export async function setSetting(key: string, value: unknown): Promise<void> {
  await run('INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

export async function audit(actorId: string | null | undefined, action: string, detail: unknown = ''): Promise<void> {
  await run('INSERT INTO audit(actor_id, action, detail) VALUES($1, $2, $3)', actorId ?? null, action,
    typeof detail === 'string' ? detail : JSON.stringify(detail));
}

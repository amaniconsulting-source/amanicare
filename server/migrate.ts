// Applies the SQL files in migrations/ in name order, once each, inside a transaction.
// Runs automatically when the server starts; can also be run alone with `npm run migrate`.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closeDb } from './db.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
// Arbitrary constant: only one process at a time may run migrations.
const LOCK_KEY = 7_270_301;

export async function migrate({ dir = MIGRATIONS_DIR, log = true } = {}): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await getPool().connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
      applied.push(file);
      if (log) console.log(`[migrate] applied ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then((applied) => { if (!applied.length) console.log('[migrate] up to date'); })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => closeDb());
}

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

// numeric -> JS number. Amounts here are far below 2^53, and the tools return JSON anyway.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number.parseFloat);
pg.types.setTypeParser(pg.types.builtins.INT8, Number.parseInt);
// date -> 'YYYY-MM-DD' string, no timezone shifts.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createPool(url = process.env.DATABASE_URL ?? 'postgres://ads:ads@localhost:5435/ads'): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function migrate(pool: pg.Pool, dir = join(import.meta.dirname, '..', 'migrations')): Promise<void> {
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await readFile(join(dir, f), 'utf8'));
  }
}

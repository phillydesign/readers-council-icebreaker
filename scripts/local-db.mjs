import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
export async function localDB(path) {
  const pg = new PGlite(path);
  try {
    const migrations = new URL('../netlify/database/migrations/', import.meta.url);
    const files = (await readdir(migrations)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
    await pg.transaction(async tx => {
      await tx.exec(`CREATE TABLE IF NOT EXISTS council_local_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      // Earlier previews created 0001 without recording it. Preserve those rooms
      // and record their existing schema before applying subsequent migrations.
      const existing = await tx.query("SELECT to_regclass('public.council_rooms') AS name");
      if (existing.rows[0].name) await tx.query(
        'INSERT INTO council_local_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', ['0001_council.sql']);
    });
    for (const name of files) {
      await pg.transaction(async tx => {
        const applied = await tx.query('SELECT name FROM council_local_migrations WHERE name=$1', [name]);
        if (applied.rows.length) return;
        await tx.exec(await readFile(new URL(name, migrations), 'utf8'));
        await tx.query('INSERT INTO council_local_migrations (name) VALUES ($1)', [name]);
      });
    }
  } catch (error) {
    await pg.close();
    throw error;
  }
  return { query:(...args)=>pg.query(...args), transaction:fn=>pg.transaction(tx=>fn({query:(...args)=>tx.query(...args)})), close:()=>pg.close() };
}

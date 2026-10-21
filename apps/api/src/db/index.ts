import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export { schema };

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export interface DbHandle { db: Db; close: () => Promise<void>; kind: 'pg' | 'pglite' }

/** url postgres:// => PostgreSQL real; 'memory://' ou vazio => PGlite em memória (testes); 'file://dir' => PGlite em disco. */
export async function createDb(url?: string): Promise<DbHandle> {
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    await migratePg(db as never, { migrationsFolder });
    return { db, close: () => pool.end(), kind: 'pg' };
  }
  const client = new PGlite(url && url.startsWith('file://') ? url.slice(7) : undefined);
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  await migratePglite(db as never, { migrationsFolder });
  return { db, close: () => client.close(), kind: 'pglite' };
}

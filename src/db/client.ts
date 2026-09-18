import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const createDb = (connectionString: string, options: { poolSize?: number } = {}) => {
  const pool = new Pool({ connectionString, max: options.poolSize ?? 10 });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return { db, pool };
};

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

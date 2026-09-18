import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client';

const migrationsFolder = join(process.cwd(), 'drizzle');

export const runMigrations = (db: Db) => migrate(db, { migrationsFolder });

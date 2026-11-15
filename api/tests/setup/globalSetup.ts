import { runner } from 'node-pg-migrate';

/** Runs once before the whole suite: bring the test database schema up to date. */
export default async function migrateTestDatabase(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is not set');
  await runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}

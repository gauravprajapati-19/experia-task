// two connection strings can differ (credentials, query params, Neon's pooled vs direct host)
// and still reach the same database. Compare what identifies the database itself.
function databaseIdentity(connectionString: string): string {
  const url = new URL(connectionString);
  const host = url.hostname.toLowerCase().replace('-pooler.', '.');
  const port = url.port || '5432';
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || decodeURIComponent(url.username);
  return `${host}:${port}/${database}`;
}

export function isSameDatabase(a: string, b: string): boolean {
  return databaseIdentity(a) === databaseIdentity(b);
}

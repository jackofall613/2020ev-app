import { Pool, QueryResultRow } from 'pg';
import { config } from '../config';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error', err);
});

export const query = <T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]) =>
  pool.query<T>(text, params);

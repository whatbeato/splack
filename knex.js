import knex from 'knex';
import 'dotenv/config';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in .env');
}

const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 2, max: 10 },
  migrations: {
    directory: './migrations',
    tableName: 'knex_migrations',
  },
});

export default db;

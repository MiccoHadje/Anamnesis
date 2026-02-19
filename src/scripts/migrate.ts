import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPool, closePool } from '../db/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const schemaPath = resolve(__dirname, '..', 'db', 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');

  const pool = getPool();
  try {
    await pool.query(sql);
    console.log('Schema applied successfully.');

    // Verify tables exist
    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'anamnesis_%'
      ORDER BY table_name
    `);
    console.log('Tables:', rows.map(r => r.table_name).join(', '));
  } finally {
    await closePool();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

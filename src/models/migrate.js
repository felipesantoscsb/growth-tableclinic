require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL CHECK (role IN ('admin','evelyn','editor','nutri')),
        nutri_name VARCHAR(255),
        whatsapp VARCHAR(20),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS content_cards (
        id SERIAL PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        pilar VARCHAR(50) NOT NULL CHECK (pilar IN ('tese','ciencia','provocacao','consultorio')),
        format VARCHAR(30) NOT NULL CHECK (format IN ('reel_curto','reel_medio','reel_longo','carrossel','carrossel_video')),
        responsible_id INT REFERENCES users(id),
        status VARCHAR(20) NOT NULL DEFAULT 'ideia' CHECK (status IN ('ideia','roteiro','gravado','edicao','programado','publicado')),
        publish_date TIMESTAMPTZ,
        drive_link TEXT,
        content TEXT,
        generated_by_ai BOOLEAN DEFAULT FALSE,
        archived BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS market_reports (
        id SERIAL PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        content TEXT NOT NULL,
        generated_at TIMESTAMPTZ DEFAULT NOW(),
        created_by INT REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS ad_copies (
        id SERIAL PRIMARY KEY,
        objective TEXT NOT NULL,
        product TEXT NOT NULL,
        audience TEXT NOT NULL,
        copies JSONB NOT NULL DEFAULT '[]',
        created_by INT REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Migration completed.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(console.error);

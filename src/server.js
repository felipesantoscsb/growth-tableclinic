require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

app.set('trust proxy', 1); // Railway / Heroku / qualquer proxy reverso
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const generalLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true });
app.use('/api', generalLimiter);

// fix: rate limit restrito para operações pesadas (Puppeteer + FFmpeg)
// keyGenerator por user ID (via JWT) para limitar por usuário, não por IP
function userKeyGen(req) {
  try {
    const jwt = require('jsonwebtoken');
    const token = req.headers.authorization?.slice(7);
    if (token) {
      const payload = jwt.decode(token);
      if (payload?.id) return `user_${payload.id}`;
    }
  } catch {}
  return req.ip;
}

const heavyLimiter = rateLimit({
  windowMs: 60_000,
  max: 4, // 4 operações pesadas por minuto por usuário
  keyGenerator: userKeyGen,
  standardHeaders: true,
  message: { success: false, error: 'Muitas requisições pesadas — aguarde 1 minuto' },
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/cards', require('./routes/cards'));
app.use('/api/generate', require('./routes/generate'));
app.use('/api/ads', require('./routes/ads'));
app.use('/api/market', require('./routes/market'));
app.use('/api/insights', require('./routes/insights'));
app.use('/api/edit', require('./routes/edit'));
app.use('/api/users', require('./routes/users'));

// Aplica heavy limiter sobre as rotas que disparam Puppeteer ou FFmpeg
app.use('/api/cards/:id/carousel', heavyLimiter);
app.use('/api/edit/video', heavyLimiter);
app.use('/api/generate/content', heavyLimiter);
app.use('/api/generate/ads', heavyLimiter);
app.use('/api/generate/repurpose', heavyLimiter);
app.use('/api/market/research', heavyLimiter);

// SPA fallback — serve index.html for all non-API routes
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, error: 'Erro interno do servidor' });
});

async function bootstrap() {
  const db = require('./models/db');

  // Migrate
  console.log('[bootstrap] Rodando migrations...');
  await db.query(`
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
  console.log('[bootstrap] Migrations OK');

  // Seed — só roda se não houver nenhum usuário ainda
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM users');
  if (parseInt(rows[0].n, 10) === 0) {
    console.log('[bootstrap] Banco vazio — rodando seed...');
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash('table2026', 10);
    const seedUsers = [
      ['Admin',    'adm@tableclinic.com.br',     'admin',  null],
      ['Evelyn',   'evelyn@tableclinic.com.br',   'evelyn', null],
      ['Felipe',   'felipe@tableclinic.com.br',   'editor', null],
      ['Luiza',    'luiza@tableclinic.com.br',    'editor', null],
      ['Juliana',  'juliana@tableclinic.com.br',  'nutri',  'Juliana'],
      ['Natalia',  'natalia@tableclinic.com.br',  'nutri',  'Natalia'],
    ];
    for (const [name, email, role, nutri_name] of seedUsers) {
      await db.query(
        `INSERT INTO users (name,email,password,role,nutri_name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [name, email, hash, role, nutri_name]
      );
    }

    // Cards de exemplo
    const { rows: ev } = await db.query(`SELECT id FROM users WHERE email='evelyn@tableclinic.com.br'`);
    const evelynId = ev[0]?.id;
    const seedCards = [
      ['Compulsão Noturna', 'tese', 'carrossel', 'publicado', 'A compulsão noturna não começa à noite.'],
      ['Alimentação Intuitiva', 'ciencia', 'reel_curto', 'publicado', 'HOOK: Você sabia que seu corpo já sabe o que precisa?'],
      ['Burnout tem gênero', 'provocacao', 'reel_medio', 'publicado', 'HOOK: Ninguém fala sobre isso, mas precisamos falar.'],
    ];
    for (const [title, pilar, format, status, content] of seedCards) {
      await db.query(
        `INSERT INTO content_cards (title,pilar,format,status,responsible_id,content,generated_by_ai) VALUES ($1,$2,$3,$4,$5,$6,false) ON CONFLICT DO NOTHING`,
        [title, pilar, format, status, evelynId, content]
      );
    }
    console.log('[bootstrap] Seed OK');
  } else {
    console.log('[bootstrap] Banco já populado — seed pulado');
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Growth TableClinic rodando na porta ${PORT}`);
    require('./jobs/weeklyReport').startWeeklyJob();
  });
}

bootstrap().catch(err => {
  console.error('[bootstrap] Erro fatal:', err.message);
  console.error('[bootstrap] Stack:', err.stack);
  console.error('[bootstrap] DATABASE_URL definida?', !!process.env.DATABASE_URL);
  process.exit(1);
});

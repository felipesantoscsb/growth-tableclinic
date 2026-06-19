require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();

app.set('trust proxy', 1); // Railway / Heroku / qualquer proxy reverso
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));
// index:false → "/" não serve index.html direto; cai no fallback que versiona os assets
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  // fix: mensagem em JSON para o frontend conseguir parsear (res.json no client)
  message: { success: false, error: 'Muitas requisições — aguarde um momento' },
});
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

// fix crítico: o heavy limiter PRECISA ser registrado ANTES dos route handlers,
// senão o router responde primeiro e o limiter nunca executa (era dead code).
app.use('/api/cards/carousel-direct', heavyLimiter);
app.use('/api/cards/:id/carousel', heavyLimiter);
app.use('/api/edit/video', heavyLimiter);
app.use('/api/generate/content', heavyLimiter);
app.use('/api/generate/ads', heavyLimiter);
app.use('/api/generate/repurpose', heavyLimiter);
app.use('/api/market/research', heavyLimiter);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/cards', require('./routes/cards'));
app.use('/api/generate', require('./routes/generate'));
app.use('/api/ads', require('./routes/ads'));
app.use('/api/market', require('./routes/market'));
app.use('/api/insights', require('./routes/insights'));
app.use('/api/edit', require('./routes/edit'));
app.use('/api/users', require('./routes/users'));
app.use('/api/editorial', require('./routes/editorial'));

// Cache-busting: injeta a versão (mtime) de app.js/style.css nas URLs dos assets.
// Cada deploy muda o mtime → a URL muda → navegador/CDN não servem versão velha.
const PUBLIC_DIR = path.join(__dirname, '../public');
const assetVer = rel => {
  try { return Math.floor(fs.statSync(path.join(PUBLIC_DIR, rel)).mtimeMs).toString(36); }
  catch { return Date.now().toString(36); }
};
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace('/js/app.js', `/js/app.js?v=${assetVer('js/app.js')}`)
  .replace('/css/style.css', `/css/style.css?v=${assetVer('css/style.css')}`);

// SPA fallback — serve o index.html (versionado), sempre revalidado (no-cache)
app.get(/^(?!\/api).*/, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(INDEX_HTML);
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

    CREATE TABLE IF NOT EXISTS editorial_posts (
      id SERIAL PRIMARY KEY,
      post_id VARCHAR(255) UNIQUE NOT NULL,
      account_username VARCHAR(100) NOT NULL DEFAULT 'nutrievelynliu',
      description TEXT,
      duration_s INT DEFAULT 0,
      published_at TIMESTAMPTZ,
      permalink TEXT,
      post_type VARCHAR(50),
      date DATE,
      views INT DEFAULT 0,
      reach INT DEFAULT 0,
      likes INT DEFAULT 0,
      shares INT DEFAULT 0,
      follows INT DEFAULT 0,
      comments INT DEFAULT 0,
      saves INT DEFAULT 0,
      editoria VARCHAR(50),
      editoria_manual BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS editorial_semanas (
      id SERIAL PRIMARY KEY,
      semana_inicio DATE UNIQUE NOT NULL,
      semana_fim DATE NOT NULL,
      fase INT DEFAULT 1,
      estado JSONB DEFAULT '{}',
      streak INT DEFAULT 0,
      placar_posts_no_alvo INT DEFAULT 0,
      placar_posts_total INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS editorial_mining_items (
      id SERIAL PRIMARY KEY,
      type VARCHAR(30) NOT NULL CHECK (type IN ('frase_de_seguidora','referencia_formato','noticia','ideia_solta')),
      content TEXT NOT NULL,
      source_url TEXT,
      expires_at DATE,
      tema VARCHAR(100),
      dor VARCHAR(100),
      editoria_provavel VARCHAR(50),
      hook_potencial BOOLEAN DEFAULT FALSE,
      status VARCHAR(20) DEFAULT 'novo' CHECK (status IN ('novo','usado','arquivado')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS editorial_temas_radar (
      id SERIAL PRIMARY KEY,
      tema TEXT NOT NULL,
      resumo TEXT,
      fonte_url TEXT,
      data_coleta DATE,
      expires_at DATE,
      score_aderencia INT,
      score_justificativa TEXT,
      editoria_sugerida VARCHAR(50),
      status VARCHAR(20) DEFAULT 'pendente' CHECK (status IN ('pendente','aprovado','descartado')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS editorial_pautas (
      id SERIAL PRIMARY KEY,
      semana_id INT REFERENCES editorial_semanas(id) ON DELETE CASCADE,
      slot_dia VARCHAR(10),
      editoria VARCHAR(50),
      formato VARCHAR(30),
      frase_tese TEXT,
      metrica_alvo VARCHAR(30),
      fontes JSONB DEFAULT '[]',
      status VARCHAR(20) DEFAULT 'proposto' CHECK (status IN ('proposto','aceito','trocado')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS editorial_roteiros (
      id SERIAL PRIMARY KEY,
      pauta_id INT REFERENCES editorial_pautas(id) ON DELETE CASCADE,
      variacao INT DEFAULT 1,
      hook TEXT,
      tensao TEXT,
      virada TEXT,
      frase_do_post TEXT,
      absolvicao TEXT,
      fechamento TEXT,
      full_content TEXT,
      flags JSONB DEFAULT '[]',
      status VARCHAR(20) DEFAULT 'rascunho' CHECK (status IN ('rascunho','aprovado','gravado','publicado','lido')),
      mining_refs JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS insights_posts (
      id SERIAL PRIMARY KEY,
      post_id VARCHAR(255) UNIQUE NOT NULL,
      account_username VARCHAR(100),
      description TEXT,
      duration_s INT DEFAULT 0,
      published_at TIMESTAMPTZ,
      permalink TEXT,
      post_type VARCHAR(50),
      date DATE,
      views INT DEFAULT 0,
      reach INT DEFAULT 0,
      likes INT DEFAULT 0,
      shares INT DEFAULT 0,
      follows INT DEFAULT 0,
      comments INT DEFAULT 0,
      saves INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE editorial_roteiros
      ADD COLUMN IF NOT EXISTS slides JSONB DEFAULT '[]';
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

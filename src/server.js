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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Growth TableClinic rodando na porta ${PORT}`);
  require('./jobs/weeklyReport').startWeeklyJob();
});

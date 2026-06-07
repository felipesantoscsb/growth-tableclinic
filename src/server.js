require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const generalLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true });
app.use('/api', generalLimiter);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/cards', require('./routes/cards'));
app.use('/api/generate', require('./routes/generate'));
app.use('/api/ads', require('./routes/ads'));
app.use('/api/market', require('./routes/market'));
app.use('/api/insights', require('./routes/insights'));
app.use('/api/edit', require('./routes/edit'));
app.use('/api/users', require('./routes/users'));

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

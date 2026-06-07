const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const db = require('../models/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../middleware/respond');
const { generateCarousel, cleanTmp } = require('../services/carousel');

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const { format, pilar, responsible_id, status, from, to } = req.query;
    let where = ['archived = false'];
    const params = [];

    if (req.user.role === 'nutri') {
      params.push(req.user.id);
      where.push(`responsible_id = $${params.length}`);
    }
    if (format) { params.push(format); where.push(`format = $${params.length}`); }
    if (pilar) { params.push(pilar); where.push(`pilar = $${params.length}`); }
    // fix #6b: nutri não pode filtrar por responsible_id alheio via query string
    if (responsible_id && req.user.role !== 'nutri') { params.push(responsible_id); where.push(`responsible_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (from) { params.push(from); where.push(`publish_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`publish_date <= $${params.length}`); }

    const { rows } = await db.query(
      `SELECT cc.*, u.name AS responsible_name FROM content_cards cc
       LEFT JOIN users u ON u.id = cc.responsible_id
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(publish_date, created_at) DESC`,
      params
    );
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
});

router.get('/week', async (req, res) => {
  try {
    const ref = req.query.date ? new Date(req.query.date) : new Date();
    // fix #6: domingo (getDay=0) deve recuar 6 dias, não avançar 1
    const day = ref.getDay();
    const offset = day === 0 ? 6 : day - 1;
    const mon = new Date(ref); mon.setDate(ref.getDate() - offset);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);

    // fix #4: usar parâmetro posicional em vez de interpolação
    const params = [mon.toISOString(), sun.toISOString()];
    const where = ['archived=false', 'publish_date BETWEEN $1 AND $2'];
    if (req.user.role === 'nutri') {
      params.push(req.user.id);
      where.push(`responsible_id = $${params.length}`);
    }

    const { rows } = await db.query(
      `SELECT cc.*, u.name AS responsible_name FROM content_cards cc
       LEFT JOIN users u ON u.id = cc.responsible_id
       WHERE ${where.join(' AND ')}
       ORDER BY publish_date`,
      params
    );
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
});

router.get('/month', async (req, res) => {
  try {
    const { year = new Date().getFullYear(), month = new Date().getMonth() + 1 } = req.query;
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0, 23, 59, 59);

    // fix #4: usar parâmetro posicional em vez de interpolação
    const params = [from.toISOString(), to.toISOString()];
    const whereM = ['archived=false', 'publish_date BETWEEN $1 AND $2'];
    if (req.user.role === 'nutri') {
      params.push(req.user.id);
      whereM.push(`responsible_id = $${params.length}`);
    }

    const { rows } = await db.query(
      `SELECT cc.*, u.name AS responsible_name FROM content_cards cc
       LEFT JOIN users u ON u.id = cc.responsible_id
       WHERE ${whereM.join(' AND ')}
       ORDER BY publish_date`,
      params
    );
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT cc.*, u.name AS responsible_name FROM content_cards cc
       LEFT JOIN users u ON u.id = cc.responsible_id
       WHERE cc.id=$1 AND cc.archived=false`,
      [req.params.id]
    );
    if (!rows[0]) return fail(res, 'Card não encontrado', 404);
    if (req.user.role === 'nutri' && rows[0].responsible_id !== req.user.id)
      return fail(res, 'Acesso negado', 403);
    ok(res, rows[0]);
  } catch (e) { fail(res, e.message); }
});

router.post('/', async (req, res) => {
  try {
    const { title, pilar, format, responsible_id, status, publish_date, drive_link, content } = req.body;
    const respId = req.user.role === 'nutri' ? req.user.id : (responsible_id || req.user.id);
    const { rows } = await db.query(
      `INSERT INTO content_cards (title,pilar,format,responsible_id,status,publish_date,drive_link,content)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [title, pilar, format, respId, status || 'ideia', publish_date || null, drive_link || null, content || null]
    );
    ok(res, rows[0]);
  } catch (e) { fail(res, e.message); }
});

router.put('/:id', async (req, res) => {
  try {
    const { rows: existing } = await db.query('SELECT * FROM content_cards WHERE id=$1', [req.params.id]);
    if (!existing[0]) return fail(res, 'Card não encontrado', 404);
    if (req.user.role === 'nutri' && existing[0].responsible_id !== req.user.id)
      return fail(res, 'Acesso negado', 403);

    const { title, pilar, format, responsible_id, status, publish_date, drive_link, content } = req.body;
    // fix #5: nutri não pode reassinar o card para outro responsible_id
    const respId = req.user.role === 'nutri' ? req.user.id : (responsible_id || existing[0].responsible_id);
    const { rows } = await db.query(
      `UPDATE content_cards SET title=$1,pilar=$2,format=$3,responsible_id=$4,status=$5,
       publish_date=$6,drive_link=$7,content=$8,updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [title, pilar, format, respId, status, publish_date || null, drive_link || null, content || null, req.params.id]
    );
    ok(res, rows[0]);
  } catch (e) { fail(res, e.message); }
});

router.put('/:id/status', async (req, res) => {
  try {
    // fix #2: verificar ownership antes de atualizar status
    const { rows: existing } = await db.query('SELECT * FROM content_cards WHERE id=$1 AND archived=false', [req.params.id]);
    if (!existing[0]) return fail(res, 'Card não encontrado', 404);
    if (req.user.role === 'nutri' && existing[0].responsible_id !== req.user.id)
      return fail(res, 'Acesso negado', 403);

    const { status } = req.body;
    const { rows } = await db.query(
      `UPDATE content_cards SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    );
    ok(res, rows[0]);
  } catch (e) { fail(res, e.message); }
});

router.delete('/:id', async (req, res) => {
  try {
    const { rows: existing } = await db.query('SELECT * FROM content_cards WHERE id=$1', [req.params.id]);
    if (!existing[0]) return fail(res, 'Card não encontrado', 404);
    if (req.user.role === 'nutri' && existing[0].responsible_id !== req.user.id)
      return fail(res, 'Acesso negado', 403);
    await db.query('UPDATE content_cards SET archived=true, updated_at=NOW() WHERE id=$1', [req.params.id]);
    ok(res, { archived: true });
  } catch (e) { fail(res, e.message); }
});

// POST /api/cards/:id/carousel — gera slides PNG do carrossel via Puppeteer
router.post('/:id/carousel', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM content_cards WHERE id=$1 AND archived=false', [req.params.id]);
    const card = rows[0];
    if (!card) return fail(res, 'Card não encontrado', 404);
    if (req.user.role === 'nutri' && card.responsible_id !== req.user.id)
      return fail(res, 'Acesso negado', 403);
    if (!['carrossel', 'carrossel_video'].includes(card.format))
      return fail(res, 'Este card não é um carrossel', 400);
    if (!card.content) return fail(res, 'Card sem conteúdo — gere o roteiro primeiro', 400);

    cleanTmp(); // limpa sessões antigas antes de criar nova

    const result = await generateCarousel(card.content, card.id);

    ok(res, {
      slides: result.slides,
      download_url: `/api/cards/carousel-download/${path.basename(result.sessionDir)}`,
      message: `${result.slides} slides gerados`,
    });
  } catch (e) {
    console.error('[carousel]', e.message);
    fail(res, e.message);
  }
});

// GET /api/cards/carousel-download/:sessionId — serve o ZIP para download
router.get('/carousel-download/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  if (!/^carousel_[\w-]+$/.test(sessionId)) return fail(res, 'ID inválido', 400);

  // fix path traversal: confirmar que o dir resolvido está contido em tmp/
  const TMP_DIR = path.resolve(__dirname, '../../tmp');
  const dir = path.resolve(TMP_DIR, sessionId);
  if (!dir.startsWith(TMP_DIR + path.sep)) return fail(res, 'ID inválido', 400);

  if (!fs.existsSync(dir)) return fail(res, 'Sessão não encontrada ou expirada', 404);
  const zipFile = fs.readdirSync(dir).find(f => f.endsWith('.zip'));
  if (!zipFile) return fail(res, 'ZIP não encontrado ou expirado', 404);

  const zipPath = path.join(dir, zipFile);
  res.setHeader('Content-Disposition', `attachment; filename="${zipFile}"`);
  res.setHeader('Content-Type', 'application/zip');
  fs.createReadStream(zipPath).pipe(res);
});

module.exports = router;

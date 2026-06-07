const router = require('express').Router();
const db = require('../models/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../middleware/respond');

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
    if (responsible_id) { params.push(responsible_id); where.push(`responsible_id = $${params.length}`); }
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
    const day = ref.getDay();
    const mon = new Date(ref); mon.setDate(ref.getDate() - day + 1);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);

    const extra = req.user.role === 'nutri' ? `AND responsible_id = ${req.user.id}` : '';
    const { rows } = await db.query(
      `SELECT cc.*, u.name AS responsible_name FROM content_cards cc
       LEFT JOIN users u ON u.id = cc.responsible_id
       WHERE archived=false AND publish_date BETWEEN $1 AND $2 ${extra}
       ORDER BY publish_date`,
      [mon.toISOString(), sun.toISOString()]
    );
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
});

router.get('/month', async (req, res) => {
  try {
    const { year = new Date().getFullYear(), month = new Date().getMonth() + 1 } = req.query;
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0, 23, 59, 59);

    const extra = req.user.role === 'nutri' ? `AND responsible_id = ${req.user.id}` : '';
    const { rows } = await db.query(
      `SELECT cc.*, u.name AS responsible_name FROM content_cards cc
       LEFT JOIN users u ON u.id = cc.responsible_id
       WHERE archived=false AND publish_date BETWEEN $1 AND $2 ${extra}
       ORDER BY publish_date`,
      [from.toISOString(), to.toISOString()]
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
    const { rows } = await db.query(
      `UPDATE content_cards SET title=$1,pilar=$2,format=$3,responsible_id=$4,status=$5,
       publish_date=$6,drive_link=$7,content=$8,updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [title, pilar, format, responsible_id, status, publish_date || null, drive_link || null, content || null, req.params.id]
    );
    ok(res, rows[0]);
  } catch (e) { fail(res, e.message); }
});

router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const { rows } = await db.query(
      `UPDATE content_cards SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows[0]) return fail(res, 'Card não encontrado', 404);
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

module.exports = router;

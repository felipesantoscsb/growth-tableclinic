const router = require('express').Router();
const db = require('../models/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../middleware/respond');
const { generateMarketResearch } = require('../services/claude');

router.use(authMiddleware, requireRole('admin', 'evelyn', 'editor'));

router.post('/research', async (req, res) => {
  try {
    const { tema } = req.body;
    if (!tema) return fail(res, 'tema obrigatório', 400);

    const content = await generateMarketResearch({ tema });
    const { rows } = await db.query(
      `INSERT INTO market_reports (title,content,created_by) VALUES ($1,$2,$3) RETURNING *`,
      [`Pesquisa: ${tema.slice(0, 200)}`, content, req.user.id]
    );
    ok(res, rows[0]);
  } catch (e) { fail(res, e.message); }
});

router.get('/reports', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT mr.*, u.name AS created_by_name FROM market_reports mr
       LEFT JOIN users u ON u.id = mr.created_by
       ORDER BY mr.generated_at DESC`
    );
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
});

router.get('/reports/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM market_reports WHERE id=$1', [req.params.id]);
    if (!rows[0]) return fail(res, 'Relatório não encontrado', 404);
    ok(res, rows[0]);
  } catch (e) { fail(res, e.message); }
});

module.exports = router;

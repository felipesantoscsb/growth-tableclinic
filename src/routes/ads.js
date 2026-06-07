const router = require('express').Router();
const db = require('../models/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../middleware/respond');

router.use(authMiddleware, requireRole('admin', 'evelyn', 'editor'));

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ac.*, u.name AS created_by_name FROM ad_copies ac
       LEFT JOIN users u ON u.id = ac.created_by
       ORDER BY ac.created_at DESC`
    );
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM ad_copies WHERE id=$1', [req.params.id]);
    if (!rows[0]) return fail(res, 'Não encontrado', 404);
    ok(res, rows[0]);
  } catch (e) { fail(res, e.message); }
});

module.exports = router;

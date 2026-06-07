const router = require('express').Router();
const db = require('../models/db');
const bcrypt = require('bcrypt');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../middleware/respond');

router.use(authMiddleware, requireRole('admin'));

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, email, role, nutri_name, whatsapp, created_at FROM users ORDER BY created_at'
    );
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
});

router.post('/', async (req, res) => {
  try {
    const { name, email, password, role, nutri_name, whatsapp } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (name,email,password,role,nutri_name,whatsapp)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,nutri_name,created_at`,
      [name, email, hash, role, nutri_name || null, whatsapp || null]
    );
    ok(res, rows[0]);
  } catch (e) { fail(res, e.message); }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, role, nutri_name, whatsapp } = req.body;
    const { rows } = await db.query(
      `UPDATE users SET name=$1, role=$2, nutri_name=$3, whatsapp=$4 WHERE id=$5
       RETURNING id,name,email,role,nutri_name`,
      [name, role, nutri_name || null, whatsapp || null, req.params.id]
    );
    if (!rows[0]) return fail(res, 'Usuário não encontrado', 404);
    ok(res, rows[0]);
  } catch (e) { fail(res, e.message); }
});

module.exports = router;

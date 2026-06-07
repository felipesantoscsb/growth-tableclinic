const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../models/db');
const { ok, fail } = require('../middleware/respond');

const limiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  message: { success: false, error: 'Muitas tentativas de login — aguarde 1 minuto' },
});

router.post('/login', limiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return fail(res, 'Email e senha obrigatórios', 400);

  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return fail(res, 'Credenciais inválidas', 401);
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name, nutri_name: user.nutri_name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    ok(res, { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, nutri_name: user.nutri_name } });
  } catch (e) {
    fail(res, e.message);
  }
});

module.exports = router;

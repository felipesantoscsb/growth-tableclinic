const router = require('express').Router();
const db = require('../models/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../middleware/respond');
const claude = require('../services/claude');

router.use(authMiddleware);

// POST /api/generate/content
router.post('/content', async (req, res) => {
  try {
    const { format, pilar, briefing, nutri_name } = req.body;
    if (!format || !pilar || !briefing) return fail(res, 'format, pilar e briefing obrigatórios', 400);

    const content = await claude.generateContent({
      format,
      pilar,
      briefing,
      user_role: req.user.role,
      nutri_name: nutri_name || req.user.nutri_name,
    });

    const title = briefing.slice(0, 80);
    const { rows } = await db.query(
      `INSERT INTO content_cards (title,pilar,format,responsible_id,status,content,generated_by_ai)
       VALUES ($1,$2,$3,$4,'roteiro',$5,true) RETURNING *`,
      [title, pilar, format, req.user.id, content]
    );

    ok(res, rows[0]);
  } catch (e) { fail(res, e.message); }
});

// POST /api/generate/ads — admin, evelyn, editor
router.post('/ads', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  try {
    const { objective, product, audience } = req.body;
    if (!objective || !product || !audience) return fail(res, 'objective, product e audience obrigatórios', 400);

    const rawCopies = await claude.generateAds({ objective, product, audience });

    const variations = rawCopies.split(/VARIAÇÃO \d+:/i).filter(Boolean).map((v, i) => ({
      index: i + 1,
      text: v.trim(),
    }));

    const { rows } = await db.query(
      `INSERT INTO ad_copies (objective,product,audience,copies,created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [objective, product, audience, JSON.stringify(variations), req.user.id]
    );

    ok(res, rows[0]);
  } catch (e) { fail(res, e.message); }
});

// POST /api/generate/repurpose
router.post('/repurpose', async (req, res) => {
  try {
    const { transcricao } = req.body;
    if (!transcricao) return fail(res, 'transcricao obrigatória', 400);

    const result = await claude.generateRepurpose({ transcricao });
    ok(res, { result });
  } catch (e) { fail(res, e.message); }
});

module.exports = router;

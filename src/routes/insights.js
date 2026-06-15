const router = require('express').Router();
const db = require('../models/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../middleware/respond');
const { analyzeInstagramPerformance } = require('../services/claude');
const { csvToObjects } = require('../services/editorialEngine');

router.use(authMiddleware, requireRole('admin', 'evelyn', 'editor'));

// ── POST /api/insights/upload-csv ──────────────────────────────────────────
// Upload do export nativo do Meta (mesma estrutura do editorial, mas histórico
// amplo — 90d/1ano). Reaproveita o parser do editorial. Dedup por post_id.
router.post('/upload-csv', async (req, res) => {
  const { csv } = req.body || {};
  if (!csv || typeof csv !== 'string') return fail(res, 'Campo "csv" obrigatório', 400);
  if (csv.length > 20_000_000) return fail(res, 'CSV muito grande (máx 20 MB)', 400);
  try {
    const { posts, warnings } = csvToObjects(csv);
    if (!posts.length) return fail(res, 'Nenhum post válido no CSV', 400);
    let inserted = 0, updated = 0;
    for (const p of posts) {
      const { rows } = await db.query(
        `INSERT INTO insights_posts
          (post_id, account_username, description, duration_s, published_at, permalink,
           post_type, date, views, reach, likes, shares, follows, comments, saves)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (post_id) DO UPDATE SET
           views=EXCLUDED.views, reach=EXCLUDED.reach, likes=EXCLUDED.likes,
           shares=EXCLUDED.shares, follows=EXCLUDED.follows, comments=EXCLUDED.comments,
           saves=EXCLUDED.saves, description=EXCLUDED.description, updated_at=NOW()
         RETURNING (xmax = 0) AS is_insert`,
        [p.post_id, p.account_username, p.description, p.duration_s, p.published_at,
         p.permalink, p.post_type, p.date, p.views, p.reach, p.likes, p.shares,
         p.follows, p.comments, p.saves]
      );
      if (rows[0]?.is_insert) inserted++; else updated++;
    }
    ok(res, { inserted, updated, total: posts.length, warnings });
  } catch (e) { console.error('[insights/upload-csv]', e.message); fail(res, e.message); }
});

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r4 = n => Math.round((n || 0) * 10000) / 10000;

// ── GET /api/insights/overview?days=90&account= ────────────────────────────
router.get('/overview', async (req, res) => {
  const days = Math.min(730, Math.max(7, parseInt(req.query.days, 10) || 90));
  const account = req.query.account || null;
  try {
    const params = [days];
    let where = `reach > 0 AND COALESCE(published_at, date::timestamptz) >= NOW() - ($1 || ' days')::interval`;
    if (account) { params.push(account); where += ` AND account_username = $${params.length}`; }

    const { rows: posts } = await db.query(
      `SELECT post_id, description, post_type, account_username, published_at, date,
              permalink, views, reach, likes, shares, follows, comments, saves
       FROM insights_posts WHERE ${where}
       ORDER BY COALESCE(published_at, date::timestamptz) DESC`, params);

    const withRates = posts.map(p => ({
      ...p,
      taxa_envio: p.shares / p.reach, taxa_seguidor: p.follows / p.reach,
      taxa_salvamento: p.saves / p.reach, taxa_comentario: p.comments / p.reach,
      taxa_engajamento: (p.likes + p.comments + p.shares + p.saves) / p.reach,
    }));

    const sum = k => withRates.reduce((a, p) => a + (p[k] || 0), 0);
    const brief = p => ({
      post_id: p.post_id, description: (p.description || '').slice(0, 120),
      post_type: p.post_type, published_at: p.published_at || p.date, permalink: p.permalink,
      reach: p.reach, views: p.views,
      taxa_envio: r4(p.taxa_envio), taxa_seguidor: r4(p.taxa_seguidor),
      taxa_salvamento: r4(p.taxa_salvamento), taxa_engajamento: r4(p.taxa_engajamento),
    });

    // por tipo de post
    const byType = {};
    for (const p of withRates) {
      const t = p.post_type || 'outro';
      (byType[t] = byType[t] || []).push(p);
    }
    const tipos = Object.entries(byType).map(([tipo, arr]) => ({
      tipo, posts: arr.length,
      mediana_engajamento: r4(median(arr.map(p => p.taxa_engajamento))),
      mediana_salvamento: r4(median(arr.map(p => p.taxa_salvamento))),
      mediana_seguidor: r4(median(arr.map(p => p.taxa_seguidor))),
    })).sort((a, b) => b.posts - a.posts);

    res.json({ success: true, data: {
      periodo_dias: days,
      total_posts: posts.length,
      totais: {
        alcance: sum('reach'), visualizacoes: sum('views'), curtidas: sum('likes'),
        comentarios: sum('comments'), compartilhamentos: sum('shares'),
        salvamentos: sum('saves'), seguidores: sum('follows'),
      },
      medianas: {
        envio: r4(median(withRates.map(p => p.taxa_envio))),
        seguidor: r4(median(withRates.map(p => p.taxa_seguidor))),
        salvamento: r4(median(withRates.map(p => p.taxa_salvamento))),
        engajamento: r4(median(withRates.map(p => p.taxa_engajamento))),
      },
      por_tipo: tipos,
      top_engajamento: [...withRates].sort((a, b) => b.taxa_engajamento - a.taxa_engajamento).slice(0, 8).map(brief),
      top_salvamento: [...withRates].sort((a, b) => b.taxa_salvamento - a.taxa_salvamento).slice(0, 8).map(brief),
      top_seguidor: [...withRates].sort((a, b) => b.taxa_seguidor - a.taxa_seguidor).slice(0, 8).map(brief),
    }});
  } catch (e) { console.error('[insights/overview]', e.message); fail(res, e.message); }
});

// ── POST /api/insights/analyze ─────────────────────────────────────────────
// Análise de IA sobre o histórico (lê de insights_posts no período).
router.post('/analyze', async (req, res) => {
  const days = Math.min(730, Math.max(7, parseInt(req.body?.days, 10) || 90));
  try {
    const { rows } = await db.query(
      `SELECT description, post_type, published_at, reach, likes, comments, shares, saves, follows, views
       FROM insights_posts
       WHERE reach > 0 AND COALESCE(published_at, date::timestamptz) >= NOW() - ($1 || ' days')::interval
       ORDER BY (likes+comments+shares+saves)::float / NULLIF(reach,0) DESC
       LIMIT 30`, [days]);
    if (!rows.length) return fail(res, 'Sem dados no período — faça upload do CSV primeiro', 400);
    const posts = rows.map(p => ({
      type: p.post_type, caption: p.description, timestamp: p.published_at,
      likes: p.likes, comments: p.comments, reach: p.reach, saved: p.saves,
      shares: p.shares, interactions: p.likes + p.comments + p.shares + p.saves,
      engagementRate: p.reach ? +(((p.likes + p.comments + p.shares + p.saves) / p.reach) * 100).toFixed(2) : 0,
    }));
    const analysis = await analyzeInstagramPerformance({ period: `${days} dias`, account: null, posts });
    ok(res, { analysis });
  } catch (e) { console.error('[insights/analyze]', e.message); fail(res, e.message); }
});

module.exports = router;

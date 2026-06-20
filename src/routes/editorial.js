/**
 * Editorial Engine — rotas API
 * Prefixo: /api/editorial
 */
const router = require('express').Router();
const { randomUUID } = require('crypto');
const db     = require('../models/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../middleware/respond');
const {
  EDITORIAS,
  MINING_TYPES,
  csvToObjects,
  upsertPosts,
  classifyUnclassified,
  getAnalytics,
  batchInsertMining,
  labelUnlabeledMining,
  listMiningItems,
  runRadar,
  gerarPauta,
  gerarRoteiros,
  validateRoteiro,
  getSemanaAtual,
  getSemanaStatus,
  avancarFase,
  salvarEstadoSemana,
  resetSemana,
  seedEditorial,
} = require('../services/editorialEngine');

// Todas as rotas exigem auth; classify/upload exigem admin ou evelyn
router.use(authMiddleware);

// Jobs do radar em memória (processo único) — radar roda 5 web searches que
// estouram o timeout do proxy se aguardados na request. Front consulta /radar/status.
const radarJobs = new Map();
const RADAR_JOB_TTL_MS = 30 * 60 * 1000;
function cleanRadarJobs() {
  const cutoff = Date.now() - RADAR_JOB_TTL_MS;
  for (const [id, j] of radarJobs) if (j.createdAt < cutoff) radarJobs.delete(id);
}

// ── POST /api/editorial/upload-csv ────────────────────────────────────────
// Body: { csv: "<texto do CSV>" }
router.post('/upload-csv', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  const { csv } = req.body || {};
  if (!csv || typeof csv !== 'string') return fail(res, 'Campo "csv" obrigatório (string)', 400);
  if (csv.length > 8_000_000) return fail(res, 'CSV muito grande (máx 8 MB)', 400);

  try {
    const { posts, warnings } = csvToObjects(csv);
    if (posts.length === 0) return fail(res, 'Nenhum post válido encontrado no CSV', 400);

    const { inserted, updated } = await upsertPosts(posts);
    ok(res, { inserted, updated, total: posts.length, warnings });
  } catch (e) {
    console.error('[editorial/upload-csv]', e.message);
    fail(res, e.message);
  }
});

// ── POST /api/editorial/classify ─────────────────────────────────────────
// Dispara classificação LLM dos posts sem editoria
// Body: { limit?: number }
router.post('/classify', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  const limit = Math.min(parseInt(req.body?.limit, 10) || 200, 500);
  try {
    const result = await classifyUnclassified(limit);
    ok(res, result);
  } catch (e) {
    console.error('[editorial/classify]', e.message);
    fail(res, e.message);
  }
});

// ── GET /api/editorial/analytics ─────────────────────────────────────────
// Retorna dashboard analítico completo
// Query: ?account=nutrievelynliu
router.get('/analytics', async (req, res) => {
  const account = req.query.account || 'nutrievelynliu';
  try {
    const data = await getAnalytics(account);
    ok(res, data);
  } catch (e) {
    console.error('[editorial/analytics]', e.message);
    fail(res, e.message);
  }
});

// ── GET /api/editorial/posts ─────────────────────────────────────────────
// Lista posts com filtros e paginação
// Query: ?account= &editoria= &sem_editoria=1 &page= &limit=
router.get('/posts', async (req, res) => {
  try {
    const {
      account = 'nutrievelynliu',
      editoria,
      sem_editoria,
      page = 1,
      limit = 50,
    } = req.query;

    const pageN  = Math.max(1, parseInt(page, 10) || 1);
    const limitN = Math.min(200, parseInt(limit, 10) || 50);
    const offset = (pageN - 1) * limitN;

    const where  = ['account_username = $1'];
    const params = [account];

    if (sem_editoria === '1') {
      where.push('editoria IS NULL');
    } else if (editoria) {
      params.push(editoria);
      where.push(`editoria = $${params.length}`);
    }

    const whereStr = where.join(' AND ');

    const [{ rows }, { rows: countRows }] = await Promise.all([
      db.query(
        `SELECT id, post_id, description, post_type, published_at, date,
                permalink, editoria, editoria_manual, reach, shares, follows,
                saves, comments, likes, views
         FROM editorial_posts
         WHERE ${whereStr}
         ORDER BY COALESCE(published_at, date::timestamptz) DESC NULLS LAST
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitN, offset]
      ),
      db.query(`SELECT COUNT(*) AS n FROM editorial_posts WHERE ${whereStr}`, params),
    ]);

    ok(res, {
      posts: rows,
      total: parseInt(countRows[0].n, 10),
      page:  pageN,
      limit: limitN,
    });
  } catch (e) {
    console.error('[editorial/posts]', e.message);
    fail(res, e.message);
  }
});

// ── PATCH /api/editorial/posts/:id/editoria ───────────────────────────────
// Correção manual de editoria — tem precedência e fica salva
// Body: { editoria: "canetas_noticia" }
router.patch('/posts/:id/editoria', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  const id      = parseInt(req.params.id, 10);
  const { editoria } = req.body || {};

  if (!Number.isFinite(id)) return fail(res, 'ID inválido', 400);
  if (!EDITORIAS.includes(editoria)) {
    return fail(res, `editoria inválida. Válidas: ${EDITORIAS.join(', ')}`, 400);
  }

  try {
    const { rowCount } = await db.query(
      `UPDATE editorial_posts
       SET editoria = $1, editoria_manual = TRUE, updated_at = NOW()
       WHERE id = $2`,
      [editoria, id]
    );
    if (rowCount === 0) return fail(res, 'Post não encontrado', 404);
    ok(res, { id, editoria });
  } catch (e) {
    console.error('[editorial/patch-editoria]', e.message);
    fail(res, e.message);
  }
});

// ── GET /api/editorial/editorias ─────────────────────────────────────────
router.get('/editorias', (req, res) => ok(res, EDITORIAS));

// ══ MINERAÇÃO ════════════════════════════════════════════════════════════════

// ── POST /api/editorial/mining ───────────────────────────────────────────
// Insere itens em lote.
// Body: { type, lines: ["...","..."] | text: "uma\npor\nlinha", source_url?, expires_at? }
// Aceita também { type, csv: "<texto csv>" } para upload de .txt/.csv
router.post('/mining', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  const { type, lines, text, csv, source_url, expires_at } = req.body || {};

  if (!MINING_TYPES.includes(type)) {
    return fail(res, `type inválido. Válidos: ${MINING_TYPES.join(', ')}`, 400);
  }

  // Montar array de linhas a partir de qualquer formato enviado
  let items = [];
  if (Array.isArray(lines)) {
    items = lines;
  } else if (text) {
    items = String(text).split('\n');
  } else if (csv) {
    // .txt ou .csv simples — uma entrada por linha (sem parse complexo)
    items = String(csv).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  } else {
    return fail(res, 'Envie "lines" (array), "text" (string) ou "csv" (string)', 400);
  }

  items = items.map(s => String(s).trim()).filter(Boolean);
  if (items.length === 0) return fail(res, 'Nenhum item válido encontrado', 400);
  if (items.length > 500) return fail(res, 'Máx 500 itens por lote', 400);

  try {
    const result = await batchInsertMining({ items, type, source_url, expires_at });
    ok(res, result);
  } catch (e) {
    console.error('[editorial/mining POST]', e.message);
    fail(res, e.message);
  }
});

// ── POST /api/editorial/mining/label ─────────────────────────────────────
// Etiqueta itens sem tema/dor via LLM
router.post('/mining/label', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  const limit = Math.min(parseInt(req.body?.limit, 10) || 300, 500);
  try {
    const result = await labelUnlabeledMining(limit);
    ok(res, result);
  } catch (e) {
    console.error('[editorial/mining/label]', e.message);
    fail(res, e.message);
  }
});

// ── GET /api/editorial/mining ────────────────────────────────────────────
// Lista itens com filtros
// Query: ?type= &status= &editoria_provavel= &hook_potencial=true &page= &limit=
router.get('/mining', async (req, res) => {
  try {
    const { type, status, editoria_provavel, hook_potencial, page = 1, limit = 60 } = req.query;
    const result = await listMiningItems({
      type, status, editoria_provavel, hook_potencial,
      page: parseInt(page, 10) || 1,
      limit: Math.min(200, parseInt(limit, 10) || 60),
    });
    ok(res, result);
  } catch (e) {
    console.error('[editorial/mining GET]', e.message);
    fail(res, e.message);
  }
});

// ── PATCH /api/editorial/mining/:id ──────────────────────────────────────
// Atualiza status, tema, dor, editoria_provavel, hook_potencial de um item
// Body: { status?, tema?, dor?, editoria_provavel?, hook_potencial? }
router.patch('/mining/:id', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return fail(res, 'ID inválido', 400);

  const VALID_STATUS = ['novo', 'usado', 'arquivado'];
  const { status, tema, dor, editoria_provavel, hook_potencial } = req.body || {};

  if (status !== undefined && !VALID_STATUS.includes(status))
    return fail(res, `status inválido. Válidos: ${VALID_STATUS.join(', ')}`, 400);
  if (editoria_provavel !== undefined && !EDITORIAS.includes(editoria_provavel))
    return fail(res, `editoria_provavel inválida`, 400);

  const sets = [];
  const params = [];

  if (status !== undefined)            { params.push(status);            sets.push(`status = $${params.length}`); }
  if (tema !== undefined)              { params.push(tema);              sets.push(`tema = $${params.length}`); }
  if (dor !== undefined)               { params.push(dor);               sets.push(`dor = $${params.length}`); }
  if (editoria_provavel !== undefined) { params.push(editoria_provavel); sets.push(`editoria_provavel = $${params.length}`); }
  if (hook_potencial !== undefined)    { params.push(!!hook_potencial);  sets.push(`hook_potencial = $${params.length}`); }

  if (sets.length === 0) return fail(res, 'Nenhum campo para atualizar', 400);

  params.push(id);
  try {
    const { rowCount } = await db.query(
      `UPDATE editorial_mining_items SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );
    if (rowCount === 0) return fail(res, 'Item não encontrado', 404);
    ok(res, { id });
  } catch (e) {
    console.error('[editorial/mining PATCH]', e.message);
    fail(res, e.message);
  }
});

// ── DELETE /api/editorial/mining/:id ─────────────────────────────────────
// Arquiva (soft delete) — muda status para 'arquivado'
router.delete('/mining/:id', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return fail(res, 'ID inválido', 400);
  try {
    const { rowCount } = await db.query(
      `UPDATE editorial_mining_items SET status = 'arquivado' WHERE id = $1`,
      [id]
    );
    if (rowCount === 0) return fail(res, 'Item não encontrado', 404);
    ok(res, { id, status: 'arquivado' });
  } catch (e) {
    console.error('[editorial/mining DELETE]', e.message);
    fail(res, e.message);
  }
});

// ── GET /api/editorial/mining/types ──────────────────────────────────────
router.get('/mining/types', (req, res) => ok(res, MINING_TYPES));

// ══ RADAR DE TEMAS ═══════════════════════════════════════════════════════════

// ── GET /api/editorial/radar ─────────────────────────────────────────────
router.get('/radar', async (req, res) => {
  try {
    const { status, expired } = req.query;
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (expired === 'false') where.push(`(expires_at IS NULL OR expires_at > NOW())`);
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const { rows } = await db.query(
      `SELECT * FROM editorial_temas_radar ${whereStr} ORDER BY created_at DESC LIMIT 100`,
      params
    );
    ok(res, rows);
  } catch (e) {
    console.error('[editorial/radar GET]', e.message);
    fail(res, e.message);
  }
});

// ── POST /api/editorial/radar/run ────────────────────────────────────────
// Inicia o radar em background e devolve job_id na hora (evita timeout do proxy).
router.post('/radar/run', requireRole('admin', 'evelyn', 'editor'), (req, res) => {
  cleanRadarJobs();
  const { queries } = req.body || {};
  const jobId = randomUUID();
  radarJobs.set(jobId, { status: 'processing', createdAt: Date.now() });

  runRadar(queries || null)
    .then(result => radarJobs.set(jobId, { status: 'done', createdAt: Date.now(), result }))
    .catch(e => {
      console.error('[editorial/radar/run]', e.message);
      radarJobs.set(jobId, { status: 'error', createdAt: Date.now(), error: e.message });
    });

  ok(res, { job_id: jobId, status: 'processing' });
});

// ── GET /api/editorial/radar/status/:jobId ───────────────────────────────
router.get('/radar/status/:jobId', (req, res) => {
  const j = radarJobs.get(req.params.jobId);
  if (!j) return fail(res, 'Job não encontrado ou expirado', 404);
  if (j.status === 'done')  return ok(res, { status: 'done', ...j.result });
  if (j.status === 'error') return ok(res, { status: 'error', error: j.error });
  ok(res, { status: 'processing' });
});

// ── PATCH /api/editorial/radar/:id ───────────────────────────────────────
router.patch('/radar/:id', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return fail(res, 'ID inválido', 400);
  const { status } = req.body || {};
  if (!['aprovado', 'descartado', 'pendente'].includes(status))
    return fail(res, 'status inválido. Válidos: aprovado, descartado, pendente', 400);
  try {
    const { rowCount } = await db.query(
      `UPDATE editorial_temas_radar SET status = $1 WHERE id = $2`,
      [status, id]
    );
    if (rowCount === 0) return fail(res, 'Tema não encontrado', 404);
    ok(res, { id, status });
  } catch (e) {
    console.error('[editorial/radar PATCH]', e.message);
    fail(res, e.message);
  }
});

// ══ SEMANA ════════════════════════════════════════════════════════════════════

// ── GET /api/editorial/semana ────────────────────────────────────────────
router.get('/semana', async (req, res) => {
  try {
    const semana = await getSemanaAtual();
    const statusData = await getSemanaStatus(semana.id);
    ok(res, statusData);
  } catch (e) {
    console.error('[editorial/semana GET]', e.message);
    fail(res, e.message);
  }
});

// ── POST /api/editorial/semana/avancar ───────────────────────────────────
router.post('/semana/avancar', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  try {
    const semana = await getSemanaAtual();
    const { dados } = req.body || {};
    const updated = await avancarFase(semana.id, dados || {});
    ok(res, updated);
  } catch (e) {
    console.error('[editorial/semana/avancar]', e.message);
    fail(res, e.message);
  }
});

// ── PATCH /api/editorial/semana/estado ───────────────────────────────────
// Salva checklist/progresso sem mudar de fase.
router.patch('/semana/estado', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  try {
    const semana = await getSemanaAtual();
    const { dados } = req.body || {};
    const updated = await salvarEstadoSemana(semana.id, dados || {});
    ok(res, updated);
  } catch (e) {
    console.error('[editorial/semana/estado]', e.message);
    fail(res, e.message);
  }
});

// ── DELETE /api/editorial/semana ─────────────────────────────────────────
// Reseta a semana atual. Pautas e roteiros são apagados em cascata.
router.delete('/semana', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  try {
    const semana = await getSemanaAtual();
    const deleted = await resetSemana(semana.id);
    ok(res, { reset: true, semana: deleted });
  } catch (e) {
    console.error('[editorial/semana DELETE]', e.message);
    fail(res, e.message);
  }
});

// ══ PAUTA ═════════════════════════════════════════════════════════════════════

// ── GET /api/editorial/pautas ────────────────────────────────────────────
router.get('/pautas', async (req, res) => {
  try {
    const { semana_id } = req.query;
    const where = semana_id ? 'WHERE semana_id = $1' : '';
    const params = semana_id ? [semana_id] : [];
    const { rows } = await db.query(
      `SELECT * FROM editorial_pautas ${where} ORDER BY created_at ASC`,
      params
    );
    ok(res, rows);
  } catch (e) {
    console.error('[editorial/pautas GET]', e.message);
    fail(res, e.message);
  }
});

// ── POST /api/editorial/pautas/gerar ─────────────────────────────────────
router.post('/pautas/gerar', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  try {
    const { semana_id, forcar = false } = req.body || {};
    if (!semana_id) return fail(res, 'semana_id obrigatório', 400);
    const pautas = await gerarPauta(semana_id, { forcar: !!forcar });
    ok(res, pautas);
  } catch (e) {
    console.error('[editorial/pautas/gerar]', e.message);
    fail(res, e.message);
  }
});

// ── PATCH /api/editorial/pautas/:id ──────────────────────────────────────
router.patch('/pautas/:id', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return fail(res, 'ID inválido', 400);
  const { status, frase_tese, metrica_alvo } = req.body || {};
  const sets = [];
  const params = [];
  if (status !== undefined)      { params.push(status);      sets.push(`status = $${params.length}`); }
  if (frase_tese !== undefined)  { params.push(frase_tese);  sets.push(`frase_tese = $${params.length}`); }
  if (metrica_alvo !== undefined){ params.push(metrica_alvo);sets.push(`metrica_alvo = $${params.length}`); }
  if (sets.length === 0) return fail(res, 'Nenhum campo para atualizar', 400);
  params.push(id);
  try {
    const { rowCount } = await db.query(
      `UPDATE editorial_pautas SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );
    if (rowCount === 0) return fail(res, 'Pauta não encontrada', 404);
    ok(res, { id });
  } catch (e) {
    console.error('[editorial/pautas PATCH]', e.message);
    fail(res, e.message);
  }
});

// ══ ROTEIROS ══════════════════════════════════════════════════════════════════

// ── POST /api/editorial/pautas/:id/roteiros ──────────────────────────────
router.post('/pautas/:id/roteiros', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  const pautaId = parseInt(req.params.id, 10);
  if (!Number.isFinite(pautaId)) return fail(res, 'ID inválido', 400);
  try {
    const roteiros = await gerarRoteiros(pautaId);
    ok(res, roteiros);
  } catch (e) {
    console.error('[editorial/pautas/roteiros POST]', e.message);
    fail(res, e.message);
  }
});

// ── GET /api/editorial/pautas/:id/roteiros ───────────────────────────────
router.get('/pautas/:id/roteiros', async (req, res) => {
  const pautaId = parseInt(req.params.id, 10);
  if (!Number.isFinite(pautaId)) return fail(res, 'ID inválido', 400);
  try {
    const { rows } = await db.query(
      `SELECT * FROM editorial_roteiros WHERE pauta_id = $1 ORDER BY variacao ASC`,
      [pautaId]
    );
    ok(res, rows);
  } catch (e) {
    console.error('[editorial/pautas/roteiros GET]', e.message);
    fail(res, e.message);
  }
});

// ── PATCH /api/editorial/roteiros/:id ────────────────────────────────────
router.patch('/roteiros/:id', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return fail(res, 'ID inválido', 400);
  const { status, hook, tensao, virada, frase_do_post, absolvicao, fechamento, full_content } = req.body || {};
  const sets = [];
  const params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (status !== undefined)       add('status', status);
  if (hook !== undefined)         add('hook', hook);
  if (tensao !== undefined)       add('tensao', tensao);
  if (virada !== undefined)       add('virada', virada);
  if (frase_do_post !== undefined)add('frase_do_post', frase_do_post);
  if (absolvicao !== undefined)   add('absolvicao', absolvicao);
  if (fechamento !== undefined)   add('fechamento', fechamento);
  if (full_content !== undefined) add('full_content', full_content);
  if (sets.length === 0) return fail(res, 'Nenhum campo para atualizar', 400);
  params.push(id);
  try {
    const { rowCount } = await db.query(
      `UPDATE editorial_roteiros SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );
    if (rowCount === 0) return fail(res, 'Roteiro não encontrado', 404);
    ok(res, { id });
  } catch (e) {
    console.error('[editorial/roteiros PATCH]', e.message);
    fail(res, e.message);
  }
});

// ── GET /api/editorial/roteiros/:id/export ───────────────────────────────
router.get('/roteiros/:id/export', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return fail(res, 'ID inválido', 400);
  try {
    const { rows } = await db.query(
      `SELECT r.*, p.slot_dia, p.editoria, p.formato FROM editorial_roteiros r
       JOIN editorial_pautas p ON p.id = r.pauta_id
       WHERE r.id = $1`,
      [id]
    );
    if (rows.length === 0) return fail(res, 'Roteiro não encontrado', 404);
    const r = rows[0];
    const lines = [
      `=== ROTEIRO ${r.variacao} — ${r.slot_dia || ''} | ${r.editoria || ''} | ${r.formato || ''} ===`,
      '',
      `HOOK:\n${r.hook || ''}`,
      '',
      `TENSÃO:\n${r.tensao || ''}`,
      '',
      `VIRADA:\n${r.virada || ''}`,
      '',
      `FRASE DO POST:\n${r.frase_do_post || ''}`,
      '',
      `ABSOLVIÇÃO:\n${r.absolvicao || ''}`,
      '',
      `FECHAMENTO:\n${r.fechamento || ''}`,
    ];
    if (r.slides) {
      let slides;
      try { slides = typeof r.slides === 'string' ? JSON.parse(r.slides) : r.slides; } catch { slides = []; }
      if (Array.isArray(slides) && slides.length) {
        lines.push('', '--- SLIDES ---');
        slides.forEach((s, i) => lines.push(`[${i + 1}] ${s}`));
      }
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="roteiro-${id}.txt"`);
    res.send(lines.join('\n'));
  } catch (e) {
    console.error('[editorial/roteiros/export]', e.message);
    fail(res, e.message);
  }
});

// ── POST /api/editorial/roteiros/:id/validate ────────────────────────────
router.post('/roteiros/:id/validate', requireRole('admin', 'evelyn', 'editor'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return fail(res, 'ID inválido', 400);
  try {
    const { rows } = await db.query(
      `SELECT full_content FROM editorial_roteiros WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return fail(res, 'Roteiro não encontrado', 404);
    const flags = validateRoteiro(rows[0].full_content || '');
    await db.query(`UPDATE editorial_roteiros SET flags = $1 WHERE id = $2`, [JSON.stringify(flags), id]);
    ok(res, { id, flags });
  } catch (e) {
    console.error('[editorial/roteiros/validate]', e.message);
    fail(res, e.message);
  }
});

// ══ SEED ══════════════════════════════════════════════════════════════════════

// ── POST /api/editorial/seed ─────────────────────────────────────────────
router.post('/seed', requireRole('admin'), async (req, res) => {
  try {
    const result = await seedEditorial();
    ok(res, result);
  } catch (e) {
    console.error('[editorial/seed]', e.message);
    fail(res, e.message);
  }
});

module.exports = router;

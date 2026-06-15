const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { authMiddleware } = require('../middleware/auth');
const { ok, fail } = require('../middleware/respond');
const { editVideo, TMP_DIR } = require('../services/videoEditor');

// GET /api/edit/download/:sessionId — serve o vídeo editado para download (sem auth — link temporário por sessionId)
router.get('/download/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  if (!/^video_[\w-]+$/.test(sessionId)) return fail(res, 'ID inválido', 400);

  const baseDir = path.resolve(TMP_DIR);
  const sessionDir = path.resolve(baseDir, sessionId);
  if (!sessionDir.startsWith(baseDir + path.sep)) return fail(res, 'ID inválido', 400);

  const outputPath = path.join(sessionDir, 'output.mp4');
  if (!fs.existsSync(outputPath)) return fail(res, 'Arquivo não encontrado ou expirado', 404);

  res.setHeader('Content-Disposition', `attachment; filename="tableclinic_${sessionId}.mp4"`);
  res.setHeader('Content-Type', 'video/mp4');
  fs.createReadStream(outputPath).pipe(res);
});

router.use(authMiddleware);

// Edição é longa (download + ffmpeg + Whisper) → roda ASSÍNCRONA, senão o proxy
// da hospedagem corta a requisição (devolve "upstream error"). Jobs em memória
// (processo único); o front consulta o progresso por GET /status.
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;
function cleanJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) if (j.createdAt < cutoff) jobs.delete(id);
}

// TTL de retenção do vídeo pronto no disco. Default 30 min (garante os 15 min
// pedidos com folga) e evita vazar disco. Configurável por VIDEO_OUTPUT_TTL_MIN.
const OUTPUT_TTL_MS = (+(process.env.VIDEO_OUTPUT_TTL_MIN || 30)) * 60 * 1000;
function cleanOldOutputs() {
  try {
    const base = path.resolve(TMP_DIR);
    if (!fs.existsSync(base)) return;
    const cutoff = Date.now() - OUTPUT_TTL_MS;
    for (const name of fs.readdirSync(base)) {
      if (!/^video_/.test(name)) continue;
      const dir = path.join(base, name);
      try {
        const st = fs.statSync(dir);
        if (st.isDirectory() && st.mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  } catch (e) { console.error('[edit/cleanup]', e.message); }
}
// roda na carga e a cada 5 min
cleanOldOutputs();
setInterval(cleanOldOutputs, 5 * 60 * 1000).unref?.();

// ─── Fila de produção ──────────────────────────────────────────────────────
// MAX_CONCURRENT rodando ao mesmo tempo; o resto espera em 'queued'. O worker
// (pump) puxa da fila conforme libera slot. Não rejeita mais com 429.
const MAX_CONCURRENT = +(process.env.VIDEO_MAX_CONCURRENT || 2);
const MAX_BATCH = +(process.env.VIDEO_MAX_BATCH || 20);
let activeJobs = 0;
const pending = [];   // jobIds aguardando slot (FIFO)

function enqueueJob({ video_url, instructions, config, cardId }) {
  const jobId = randomUUID();
  jobs.set(jobId, {
    status: 'queued', createdAt: Date.now(),
    input: { video_url, instructions: instructions || '', config: config || {}, cardId },
  });
  pending.push(jobId);
  pump();
  return jobId;
}

function pump() {
  while (activeJobs < MAX_CONCURRENT && pending.length) {
    const jobId = pending.shift();
    const job = jobs.get(jobId);
    if (!job || job.status !== 'queued') continue;
    activeJobs++;
    jobs.set(jobId, { ...job, status: 'processing', startedAt: Date.now() });

    editVideo(job.input)
      .then(result => {
        jobs.set(jobId, {
          status: 'done', createdAt: job.createdAt,
          result: {
            duration_original: result.duration_original,
            duration_output: result.duration_output,
            size_mb: result.size_mb,
            ops_applied: result.ops_applied,
            enhance_report: result.enhance_report,
            download_url: `/api/edit/download/${path.basename(result.sessionDir)}`,
          },
        });
      })
      .catch(e => {
        console.error('[edit/video]', e.message);
        jobs.set(jobId, { status: 'error', createdAt: job.createdAt, error: e.message });
      })
      .finally(() => { activeJobs = Math.max(0, activeJobs - 1); pump(); });
  }
}

// posição na fila (1-based) p/ o front mostrar "2º na fila"
function queuePosition(jobId) {
  const i = pending.indexOf(jobId);
  return i < 0 ? 0 : i + 1;
}

// POST /api/edit/video — enfileira 1 OU vários vídeos. Devolve job_id(s) na hora.
// Body: { video_url } OU { video_urls: [...] } (+ instructions/config aplicados a todos)
router.post('/video', (req, res) => {
  cleanJobs();
  const { video_url, video_urls, instructions, card_id, config } = req.body;

  let urls = [];
  if (Array.isArray(video_urls)) urls = video_urls;
  else if (video_url) urls = [video_url];
  urls = urls.map(u => String(u || '').trim()).filter(Boolean);

  if (!urls.length) return fail(res, 'Envie video_url ou video_urls (lista)', 400);
  if (urls.length > MAX_BATCH) return fail(res, `Máx ${MAX_BATCH} vídeos por vez`, 400);

  const cardId = card_id || req.user.id;
  const ids = urls.map(u => enqueueJob({ video_url: u, instructions, config, cardId }));

  // resposta retrocompatível: job_id (1º) + jobs[] com url p/ a fila do front
  ok(res, {
    job_id: ids[0],
    jobs: ids.map((id, i) => ({ job_id: id, video_url: urls[i] })),
    queued: ids.length,
    concurrency: MAX_CONCURRENT,
  });
});

// GET /api/edit/status-batch?ids=a,b,c — status de vários jobs num request só
// (evita estourar o rate-limit ao polar uma fila inteira).
router.get('/status-batch', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  const out = {};
  for (const id of ids) {
    const j = jobs.get(id);
    if (!j) { out[id] = { status: 'gone' }; continue; }
    if (j.status === 'done')  out[id] = { status: 'done', ...j.result };
    else if (j.status === 'error') out[id] = { status: 'error', error: j.error };
    else if (j.status === 'queued') out[id] = { status: 'queued', position: queuePosition(id) };
    else out[id] = { status: 'processing' };
  }
  ok(res, out);
});

// GET /api/edit/status/:jobId — progresso/resultado. Fora do prefixo /video de
// propósito, pra escapar do heavy limiter (4/min) durante o polling.
router.get('/status/:jobId', (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j) return fail(res, 'Edição não encontrada ou expirada', 404);
  if (j.status === 'done')  return ok(res, { status: 'done', ...j.result });
  if (j.status === 'error') return ok(res, { status: 'error', error: j.error });
  if (j.status === 'queued') return ok(res, { status: 'queued', position: queuePosition(req.params.jobId) });
  ok(res, { status: 'processing' });
});

module.exports = router;

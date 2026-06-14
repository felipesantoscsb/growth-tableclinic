const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { authMiddleware } = require('../middleware/auth');
const { ok, fail } = require('../middleware/respond');
const { editVideo } = require('../services/videoEditor');

// GET /api/edit/download/:sessionId — serve o vídeo editado para download (sem auth — link temporário por sessionId)
router.get('/download/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  if (!/^video_[\w-]+$/.test(sessionId)) return fail(res, 'ID inválido', 400);

  const TMP_DIR = path.resolve(__dirname, '../../tmp');
  const sessionDir = path.resolve(TMP_DIR, sessionId);
  if (!sessionDir.startsWith(TMP_DIR + path.sep)) return fail(res, 'ID inválido', 400);

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

// Limite de edições simultâneas por worker (ffmpeg satura CPU). Configurável.
const MAX_CONCURRENT = +(process.env.VIDEO_MAX_CONCURRENT || 2);
let activeJobs = 0;

// POST /api/edit/video — inicia a edição em background e devolve um job_id na hora
router.post('/video', (req, res) => {
  const { video_url, instructions, card_id, config } = req.body;
  if (!video_url) return fail(res, 'video_url obrigatório', 400);
  if (activeJobs >= MAX_CONCURRENT)
    return fail(res, 'Servidor processando outros vídeos no momento — tente em instantes', 429);
  cleanJobs();

  const jobId = randomUUID();
  jobs.set(jobId, { status: 'processing', createdAt: Date.now() });
  activeJobs++;

  // instructions é opcional: sem ela, roda o padrão (corte natural + legendas)
  editVideo({ video_url, instructions: instructions || '', cardId: card_id || req.user.id, config: config || {} })
    .then(result => {
      jobs.set(jobId, {
        status: 'done', createdAt: Date.now(),
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
      jobs.set(jobId, { status: 'error', createdAt: Date.now(), error: e.message });
    })
    .finally(() => { activeJobs = Math.max(0, activeJobs - 1); });

  ok(res, { job_id: jobId, status: 'processing' });
});

// GET /api/edit/status/:jobId — progresso/resultado. Fora do prefixo /video de
// propósito, pra escapar do heavy limiter (4/min) durante o polling.
router.get('/status/:jobId', (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j) return fail(res, 'Edição não encontrada ou expirada', 404);
  if (j.status === 'done') return ok(res, { status: 'done', ...j.result });
  if (j.status === 'error') return ok(res, { status: 'error', error: j.error });
  ok(res, { status: 'processing' });
});

module.exports = router;

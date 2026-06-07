const router = require('express').Router();
const path = require('path');
const fs = require('fs');
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

// POST /api/edit/video — edição real via FFmpeg
router.post('/video', async (req, res) => {
  try {
    const { video_url, instructions, card_id } = req.body;
    if (!video_url || !instructions) return fail(res, 'video_url e instructions obrigatórios', 400);

    const result = await editVideo({ video_url, instructions, cardId: card_id || req.user.id });

    ok(res, {
      duration_original: result.duration_original,
      duration_output: result.duration_output,
      size_mb: result.size_mb,
      ops_applied: result.ops_applied,
      download_url: `/api/edit/download/${path.basename(result.sessionDir)}`,
    });
  } catch (e) {
    console.error('[edit/video]', e.message);
    fail(res, e.message);
  }
});

module.exports = router;

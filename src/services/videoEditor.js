const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

ffmpeg.setFfmpegPath(ffmpegPath);

const TMP_DIR = path.join(__dirname, '../../tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(`Download falhou: HTTP ${res.statusCode}`));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

function getVideoDuration(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, meta) => {
      if (err) return reject(err);
      resolve(meta.format.duration || 0);
    });
  });
}

// Parseia instruções em linguagem natural → parâmetros de edição
function parseInstructions(instructions, duration) {
  const ops = {
    trim: null,       // { start, end }
    resize: null,     // '9:16' | '1:1' | '16:9'
    subtitles: false,
    speed: null,      // 0.5–2.0
    volume: null,     // 0.0–2.0
    mute: false,
    grayscale: false,
  };

  const text = instructions.toLowerCase();

  // Cortes / trim
  const trimMatch = text.match(/(?:cortar?|trim|a partir d[eo]|começa?r?\s+em?|do segundo)\s+(\d+)/i)
    || text.match(/(\d+)s?\s+(?:a[oté]+|até\s+o\s+segundo|–|-)\s+(\d+)/i);
  if (trimMatch) {
    if (trimMatch[2]) {
      ops.trim = { start: parseFloat(trimMatch[1]), end: parseFloat(trimMatch[2]) };
    } else {
      ops.trim = { start: parseFloat(trimMatch[1]), end: duration };
    }
  }

  // Remover início (primeiros N segundos)
  const removeStartMatch = text.match(/remov[ae]r?\s+(?:os\s+)?(?:primeiros?\s+)?(\d+)\s*s/i)
    || text.match(/pular?\s+(?:os\s+)?primeiros?\s+(\d+)/i);
  if (removeStartMatch) {
    ops.trim = { start: parseFloat(removeStartMatch[1]), end: duration };
  }

  // Aspect ratio
  if (text.match(/9[:/]16|vertical|stories?|reels?/)) ops.resize = '9:16';
  else if (text.match(/1[:/]1|quadrad[oa]|square/)) ops.resize = '1:1';
  else if (text.match(/16[:/]9|horizontal|paisagem|widescreen/)) ops.resize = '16:9';

  // Legendas
  if (text.match(/legend[as]|caption|subtitle|srt/)) ops.subtitles = true;

  // Velocidade
  const speedMatch = text.match(/(\d+(?:\.\d+)?)[x×]\s*(?:velocidade|speed)/i)
    || text.match(/velocidade\s+(\d+(?:\.\d+)?)/i);
  if (speedMatch) ops.speed = Math.min(2.0, Math.max(0.5, parseFloat(speedMatch[1])));

  // Volume / mudo
  if (text.match(/sem\s+(?:áudio|som)|mudo|mute|silenci/i)) ops.mute = true;
  else {
    const volMatch = text.match(/volume[:\s]+(\d+)%/i);
    if (volMatch) ops.volume = parseFloat(volMatch[1]) / 100;
  }

  // Preto e branco
  if (text.match(/preto\s+e\s+branco|grayscale|cinza|b&w/i)) ops.grayscale = true;

  return ops;
}

async function editVideo({ video_url, instructions, cardId }) {
  const sessionId = `video_${cardId || 'tmp'}_${Date.now()}`;
  const sessionDir = path.join(TMP_DIR, sessionId);
  fs.mkdirSync(sessionDir);

  // Download do vídeo fonte
  const ext = video_url.match(/\.(mp4|mov|webm|avi|mkv)/i)?.[1] || 'mp4';
  const inputPath = path.join(sessionDir, `input.${ext}`);
  await downloadFile(video_url, inputPath);

  const duration = await getVideoDuration(inputPath);
  const ops = parseInstructions(instructions, duration);
  const outputPath = path.join(sessionDir, 'output.mp4');

  await new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath);

    // Trim
    if (ops.trim) {
      cmd = cmd.setStartTime(ops.trim.start);
      if (ops.trim.end < duration) cmd = cmd.setDuration(ops.trim.end - ops.trim.start);
    }

    // Filtros de vídeo
    const vFilters = [];

    // Resize / crop para aspect ratio
    if (ops.resize === '9:16') {
      // crop centralizado para 9:16 a partir de qualquer tamanho
      vFilters.push("crop=ih*9/16:ih,scale=1080:1920");
    } else if (ops.resize === '1:1') {
      vFilters.push("crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080");
    } else if (ops.resize === '16:9') {
      vFilters.push("scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2");
    }

    // Velocidade (afeta vídeo e áudio separadamente)
    if (ops.speed && ops.speed !== 1.0) {
      vFilters.push(`setpts=${(1 / ops.speed).toFixed(4)}*PTS`);
    }

    // Preto e branco
    if (ops.grayscale) vFilters.push('hue=s=0');

    if (vFilters.length > 0) cmd = cmd.videoFilters(vFilters);

    // Filtros de áudio
    if (ops.mute) {
      cmd = cmd.noAudio();
    } else {
      const aFilters = [];
      if (ops.speed && ops.speed !== 1.0) {
        // atempo aceita apenas 0.5–2.0; encadear para valores extremos
        const s = ops.speed;
        if (s > 2.0) aFilters.push('atempo=2.0', `atempo=${(s / 2.0).toFixed(4)}`);
        else if (s < 0.5) aFilters.push('atempo=0.5', `atempo=${(s / 0.5).toFixed(4)}`);
        else aFilters.push(`atempo=${s.toFixed(4)}`);
      }
      if (ops.volume !== null) aFilters.push(`volume=${ops.volume}`);
      if (aFilters.length > 0) cmd = cmd.audioFilters(aFilters);
    }

    // Encode final sempre em H.264 + AAC para compatibilidade máxima
    cmd
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart', // streaming-friendly
        '-pix_fmt yuv420p',     // compatibilidade iPhone/WhatsApp
      ])
      .output(outputPath)
      .on('start', cmd => console.log('[FFmpeg] Iniciando:', cmd))
      .on('progress', p => console.log(`[FFmpeg] ${Math.round(p.percent || 0)}%`))
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  const stat = fs.statSync(outputPath);

  return {
    outputPath,
    sessionDir,
    duration_original: Math.round(duration),
    duration_output: ops.trim
      ? Math.round((ops.trim.end - ops.trim.start) / (ops.speed || 1))
      : Math.round(duration / (ops.speed || 1)),
    size_mb: (stat.size / 1_048_576).toFixed(2),
    ops_applied: ops,
  };
}

module.exports = { editVideo };

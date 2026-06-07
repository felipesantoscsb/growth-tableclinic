const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const https = require('https');
const http = require('http');
const { isDriveUrl, downloadFromDrive } = require('./driveDownloader');

ffmpeg.setFfmpegPath(ffmpegPath);

const TMP_DIR = path.join(__dirname, '../../tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

// fix SSRF: bloqueia IPs privados, loopback e link-local
const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^0\.0\.0\.0$/,
];

async function assertPublicUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('URL inválida'); }

  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('Apenas URLs http:// e https:// são permitidas');

  const hostname = parsed.hostname;

  // Rejeita hostnames que parecem internos antes mesmo do DNS
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal'))
    throw new Error('URL aponta para host interno — não permitido');

  // Resolve DNS e verifica se o IP resultante é privado
  let addresses;
  try { addresses = await dns.resolve4(hostname); } catch { addresses = []; }
  try { addresses = [...addresses, ...(await dns.resolve6(hostname))]; } catch {}

  for (const ip of addresses) {
    if (PRIVATE_RANGES.some(re => re.test(ip)))
      throw new Error(`URL aponta para endereço de rede privada (${ip}) — não permitido`);
  }
}

// fix: download com limite de tamanho e proteção SSRF
async function downloadFile(url, dest) {
  await assertPublicUrl(url);

  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    let downloaded = 0;
    const file = fs.createWriteStream(dest);

    const req = proto.get(url, res => {
      // Verifica Content-Length antes de começar
      const contentLength = parseInt(res.headers['content-length'] || '0', 10);
      if (contentLength > MAX_BYTES) {
        req.destroy();
        file.destroy();
        return reject(new Error(`Arquivo muito grande: ${(contentLength / 1_048_576).toFixed(0)} MB (máximo 500 MB)`));
      }

      if (res.statusCode === 301 || res.statusCode === 302) {
        // Segue redirect mas revalida o destino
        file.destroy();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200)
        return reject(new Error(`Download falhou: HTTP ${res.statusCode}`));

      res.on('data', chunk => {
        downloaded += chunk.length;
        if (downloaded > MAX_BYTES) {
          req.destroy();
          file.destroy();
          reject(new Error('Arquivo excedeu limite de 500 MB durante download'));
        }
      });

      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Timeout no download do vídeo')); });
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

function parseInstructions(instructions, duration) {
  const ops = {
    trim: null,
    resize: null,
    subtitles: false,
    speed: null,
    volume: null,
    mute: false,
    grayscale: false,
  };

  const text = instructions.toLowerCase();

  const trimMatch = text.match(/(?:cortar?|trim|a partir d[eo]|começa?r?\s+em?|do segundo)\s+(\d+)/i)
    || text.match(/(\d+)s?\s+(?:a[oté]+|até\s+o\s+segundo|–|-)\s+(\d+)/i);
  if (trimMatch) {
    if (trimMatch[2]) {
      ops.trim = { start: parseFloat(trimMatch[1]), end: parseFloat(trimMatch[2]) };
    } else {
      ops.trim = { start: parseFloat(trimMatch[1]), end: duration };
    }
  }

  const removeStartMatch = text.match(/remov[ae]r?\s+(?:os\s+)?(?:primeiros?\s+)?(\d+)\s*s/i)
    || text.match(/pular?\s+(?:os\s+)?primeiros?\s+(\d+)/i);
  if (removeStartMatch) {
    ops.trim = { start: parseFloat(removeStartMatch[1]), end: duration };
  }

  if (text.match(/9[:/]16|vertical|stories?|reels?/)) ops.resize = '9:16';
  else if (text.match(/1[:/]1|quadrad[oa]|square/)) ops.resize = '1:1';
  else if (text.match(/16[:/]9|horizontal|paisagem|widescreen/)) ops.resize = '16:9';

  if (text.match(/legend[as]|caption|subtitle|srt/)) ops.subtitles = true;

  const speedMatch = text.match(/(\d+(?:\.\d+)?)[x×]\s*(?:velocidade|speed)/i)
    || text.match(/velocidade\s+(\d+(?:\.\d+)?)/i);
  if (speedMatch) ops.speed = Math.min(2.0, Math.max(0.5, parseFloat(speedMatch[1])));

  if (text.match(/sem\s+(?:áudio|som)|mudo|mute|silenci/i)) ops.mute = true;
  else {
    const volMatch = text.match(/volume[:\s]+(\d+)%/i);
    if (volMatch) ops.volume = parseFloat(volMatch[1]) / 100;
  }

  if (text.match(/preto\s+e\s+branco|grayscale|cinza|b&w/i)) ops.grayscale = true;

  return ops;
}

async function editVideo({ video_url, instructions, cardId }) {
  const sessionId = `video_${cardId || 'tmp'}_${Date.now()}`;
  const sessionDir = path.join(TMP_DIR, sessionId);
  fs.mkdirSync(sessionDir);

  const ext = video_url.match(/\.(mp4|mov|webm|avi|mkv)/i)?.[1] || 'mp4';
  const inputPath = path.join(sessionDir, `input.${ext}`);

  // Integração Google Drive: roteia pelo downloader autenticado
  if (isDriveUrl(video_url)) {
    await downloadFromDrive(video_url, inputPath);
  } else {
    await downloadFile(video_url, inputPath);
  }

  const duration = await getVideoDuration(inputPath);
  const ops = parseInstructions(instructions, duration);
  const outputPath = path.join(sessionDir, 'output.mp4');

  await new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath);

    if (ops.trim) {
      cmd = cmd.setStartTime(ops.trim.start);
      if (ops.trim.end < duration) cmd = cmd.setDuration(ops.trim.end - ops.trim.start);
    }

    const vFilters = [];
    if (ops.resize === '9:16') {
      vFilters.push('crop=ih*9/16:ih,scale=1080:1920');
    } else if (ops.resize === '1:1') {
      vFilters.push('crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080');
    } else if (ops.resize === '16:9') {
      vFilters.push('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2');
    }

    if (ops.speed && ops.speed !== 1.0) vFilters.push(`setpts=${(1 / ops.speed).toFixed(4)}*PTS`);
    if (ops.grayscale) vFilters.push('hue=s=0');
    if (vFilters.length > 0) cmd = cmd.videoFilters(vFilters);

    if (ops.mute) {
      cmd = cmd.noAudio();
    } else {
      const aFilters = [];
      if (ops.speed && ops.speed !== 1.0) {
        const s = ops.speed;
        if (s > 2.0) aFilters.push('atempo=2.0', `atempo=${(s / 2.0).toFixed(4)}`);
        else if (s < 0.5) aFilters.push('atempo=0.5', `atempo=${(s / 0.5).toFixed(4)}`);
        else aFilters.push(`atempo=${s.toFixed(4)}`);
      }
      if (ops.volume !== null) aFilters.push(`volume=${ops.volume}`);
      if (aFilters.length > 0) cmd = cmd.audioFilters(aFilters);
    }

    cmd
      .outputOptions(['-c:v libx264', '-preset fast', '-crf 23', '-c:a aac', '-b:a 128k', '-movflags +faststart', '-pix_fmt yuv420p'])
      .output(outputPath)
      .on('start', c => console.log('[FFmpeg] Iniciando:', c))
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

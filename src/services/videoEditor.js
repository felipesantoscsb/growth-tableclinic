const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const https = require('https');
const http = require('http');
const { isDriveUrl, downloadFromDrive } = require('./driveDownloader');

// fix: prefere binários do sistema (o Dockerfile instala ffmpeg/ffprobe com libass,
// necessário para os filtros `subtitles` e `silencedetect`). Cai para o pacote npm
// localmente. Sobrescrevível via FFMPEG_PATH / FFPROBE_PATH.
function resolveBin(name, installerModule) {
  const envVar = process.env[`${name.toUpperCase()}_PATH`];
  if (envVar) return envVar;
  const sysPath = `/usr/bin/${name}`;
  if (fs.existsSync(sysPath)) return sysPath;
  try { return require(installerModule).path; } catch { return name; }
}
ffmpeg.setFfmpegPath(resolveBin('ffmpeg', '@ffmpeg-installer/ffmpeg'));
ffmpeg.setFfprobePath(resolveBin('ffprobe', '@ffprobe-installer/ffprobe'));

// Cliente OpenAI (Whisper) para transcrição de legendas — carregado sob demanda
let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) return null;
  const OpenAI = require('openai');
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

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
    removeSilence: false,
    speed: null,
    volume: null,
    mute: false,
    grayscale: false,
  };

  // Normaliza acentos: "silêncios"/"silencios", "áudio"/"audio" etc. viram a
  // mesma coisa — usuários frequentemente digitam sem acento.
  const text = instructions.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

  const trimMatch = text.match(/(?:cortar?|trim|a partir d[eo]|comeca?r?\s+em?|do segundo)\s+(\d+)/i)
    || text.match(/(\d+)s?\s+(?:a[ote]+|ate\s+o\s+segundo|–|-)\s+(\d+)/i);
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
  // Remoção de pausas reage ao SUBSTANTIVO "silêncio(s)" (lacunas sem fala)
  if (text.match(/paus[as]|silencio|silence|cortar\s+paus/i)) ops.removeSilence = true;

  const speedMatch = text.match(/(\d+(?:\.\d+)?)[x×]\s*(?:velocidade|speed)/i)
    || text.match(/velocidade\s+(\d+(?:\.\d+)?)/i);
  if (speedMatch) ops.speed = Math.min(2.0, Math.max(0.5, parseFloat(speedMatch[1])));

  // Mute reage ao VERBO "silenciar/silencie" (não ao substantivo "silêncio",
  // que é remoção de pausas) — evita que "cortar os silêncios" tire todo o áudio.
  if (text.match(/sem\s+(?:audio|som)|(?:tirar|remover)\s+(?:o\s+)?(?:audio|som)|mudo|mute|silenci[ae]/i)) ops.mute = true;
  else {
    const volMatch = text.match(/volume[:\s]+(\d+)%/i);
    if (volMatch) ops.volume = parseFloat(volMatch[1]) / 100;
  }

  if (text.match(/preto\s+e\s+branco|grayscale|cinza|b&w/i)) ops.grayscale = true;

  return ops;
}

// Detecta segmentos de silêncio e retorna lista de intervalos com fala
function detectSilenceSegments(inputPath) {
  return new Promise((resolve, reject) => {
    const silences = [];
    let stderr = '';
    ffmpeg(inputPath)
      .audioFilters('silencedetect=noise=-35dB:d=0.5')
      .outputOptions(['-f null'])
      .output('/dev/null')
      .on('stderr', line => {
        stderr += line + '\n';
        const startMatch = line.match(/silence_start: ([\d.]+)/);
        const endMatch   = line.match(/silence_end: ([\d.]+)/);
        if (startMatch) silences.push({ start: parseFloat(startMatch[1]) });
        if (endMatch && silences.length > 0 && silences[silences.length-1].end === undefined)
          silences[silences.length-1].end = parseFloat(endMatch[1]);
      })
      .on('end', () => resolve(silences))
      .on('error', reject)
      .run();
  });
}

// Constrói filtro FFmpeg para remover segmentos de silêncio
function buildSilenceRemoveFilter(silences, duration) {
  // Constrói lista de segmentos de fala
  const speechSegments = [];
  let cursor = 0;
  for (const s of silences) {
    const start = s.start ?? 0;
    const end   = s.end   ?? duration;
    if (start > cursor + 0.1) speechSegments.push({ start: cursor, end: start });
    cursor = end;
  }
  if (cursor < duration - 0.1) speechSegments.push({ start: cursor, end: duration });
  if (speechSegments.length === 0) return null;

  // trim + concat via filtergraph
  const vParts = speechSegments.map((s, i) => `[0:v]trim=${s.start}:${s.end},setpts=PTS-STARTPTS[v${i}]`);
  const aParts = speechSegments.map((s, i) => `[0:a]atrim=${s.start}:${s.end},asetpts=PTS-STARTPTS[a${i}]`);
  const vInputs = speechSegments.map((_, i) => `[v${i}]`).join('');
  const aInputs = speechSegments.map((_, i) => `[a${i}]`).join('');
  const n = speechSegments.length;
  const filter = [
    ...vParts, ...aParts,
    `${vInputs}concat=n=${n}:v=1:a=0[vout]`,
    `${aInputs}concat=n=${n}:v=0:a=1[aout]`,
  ].join(';');
  return { filter, speechSegments };
}

// Verifica se o arquivo tem ao menos uma faixa de áudio (via ffprobe)
function hasAudioStream(inputPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, meta) => {
      if (err || !meta || !Array.isArray(meta.streams)) return resolve(false);
      resolve(meta.streams.some(s => s.codec_type === 'audio'));
    });
  });
}

// Transcreve o áudio do vídeo e gera um arquivo .srt (OpenAI Whisper)
// Whisper "alucina" frases dos dados de treino quando o áudio é silencioso ou
// sem fala — a mais comum em PT é "Legendas pela comunidade Amara.org". Lista de
// assinaturas a descartar para não queimar esse lixo no vídeo.
const SRT_HALLUCINATIONS = [
  'amara.org',
  'legendas pela comunidade',
  'legendado pela comunidade',
  'subtitles by',
  'subtitulado por',
  'obrigado por assistir',
  'obrigada por assistir',
  'thanks for watching',
  'thank you for watching',
  'se inscreva no canal',
];

// Remove cues de alucinação/ruído de um SRT e re-numera. Retorna '' se sobrar nada.
function cleanSrtHallucinations(srt) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
  const blocks = String(srt || '').replace(/\r/g, '').trim().split(/\n\s*\n/).filter(b => b.trim());
  const kept = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const tIdx = lines.findIndex(l => l.includes('-->'));
    if (tIdx < 0) continue; // bloco malformado
    const textLines = lines.slice(tIdx + 1);
    const joined = textLines.join(' ').trim();
    const text = norm(joined);
    if (!text) continue;
    const isHallucination = SRT_HALLUCINATIONS.some(p => text.includes(p));
    const onlyMusic = /^[\s♪♫]+$/.test(joined);
    if (isHallucination || onlyMusic) continue;
    kept.push({ timeLine: lines[tIdx], textLines });
  }
  if (kept.length === 0) return '';
  return kept.map((c, i) => `${i + 1}\n${c.timeLine}\n${c.textLines.join('\n')}`).join('\n\n') + '\n';
}

async function transcribeToSrt(videoPath, sessionDir) {
  const openai = getOpenAI();
  if (!openai) throw new Error('Legendas exigem OPENAI_API_KEY configurada no ambiente');

  // Sem áudio não há o que transcrever — erro claro em vez do críptico do ffmpeg
  if (!(await hasAudioStream(videoPath)))
    throw new Error('o vídeo não tem faixa de áudio para transcrever');

  // Extrai só o áudio (mp3 leve) para acelerar o upload
  const audioPath = path.join(sessionDir, 'audio.mp3');
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .output(audioPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  const srt = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: process.env.WHISPER_MODEL || 'whisper-1',
    response_format: 'srt',
    language: 'pt',
  });

  // Filtra alucinações do Whisper (Amara.org etc.). Se não sobrar legenda real,
  // é áudio sem fala — falha de propósito para entregar o vídeo sem legenda.
  const cleaned = cleanSrtHallucinations(typeof srt === 'string' ? srt : String(srt));
  if (!cleaned.trim())
    throw new Error('transcrição vazia ou só com ruído (áudio sem fala) — vídeo entregue sem legenda');

  const srtPath = path.join(sessionDir, 'subs.srt');
  fs.writeFileSync(srtPath, cleaned);
  return srtPath;
}

// Passo de remoção de silêncios (trim+concat) → arquivo intermediário
function runSilenceRemoval(inputPath, silenceFilter, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .complexFilter(silenceFilter.filter)
      .outputOptions([
        '-map [vout]', '-map [aout]',
        '-c:v libx264', '-preset fast', '-crf 23',
        '-c:a aac', '-b:a 128k',
        '-movflags +faststart', '-pix_fmt yuv420p',
      ])
      .output(outPath)
      .on('start', () => console.log('[FFmpeg] Removendo silêncios...'))
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Passo principal: resize, velocidade, grayscale, volume, mute, trim
function runMainPass(inputPath, ops, duration, outPath) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath);

    if (ops.trim) {
      cmd = cmd.setStartTime(ops.trim.start);
      if (ops.trim.end < duration) cmd = cmd.setDuration(ops.trim.end - ops.trim.start);
    }

    const vFilters = [];
    if (ops.resize === '9:16') vFilters.push('crop=ih*9/16:ih,scale=1080:1920');
    else if (ops.resize === '1:1') vFilters.push('crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080');
    else if (ops.resize === '16:9') vFilters.push('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2');
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
      .output(outPath)
      .on('start', c => console.log('[FFmpeg] Iniciando passo principal:', c))
      .on('progress', p => console.log(`[FFmpeg] ${Math.round(p.percent || 0)}%`))
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Queima as legendas (.srt) no vídeo. Se muteAudio, remove o áudio aqui
// (usado quando o usuário pediu mudo + legendas: o áudio foi preservado só
// para a transcrição e agora é descartado).
function burnSubtitles(inputPath, srtPath, outPath, { muteAudio = false } = {}) {
  return new Promise((resolve, reject) => {
    // Escapa o caminho para o filtro subtitles do ffmpeg
    const escaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    // Fontname precisa existir na imagem — o Dockerfile instala fonts-liberation
    // Sans em negrito p/ máxima leitura em vídeo (a ID visual usa Cormorant só
    // em título/capa — serif fino não lê bem em legenda sobre imagem).
    // Fontsize é relativo à altura de script do libass (~288), então 12 ≈ 4% da
    // altura do vídeo — legível sem ficar gigante em vídeos verticais (1080×1920).
    const style = "force_style='Fontname=Liberation Sans,Fontsize=12,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginV=40'";
    const audioOpts = muteAudio ? ['-an'] : ['-c:a copy'];
    ffmpeg(inputPath)
      .videoFilters(`subtitles='${escaped}':${style}`)
      .outputOptions(['-c:v libx264', '-preset fast', '-crf 23', ...audioOpts, '-movflags +faststart', '-pix_fmt yuv420p'])
      .output(outPath)
      .on('start', () => console.log('[FFmpeg] Queimando legendas...'))
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Remove a faixa de áudio sem reencodar o vídeo (rápido)
function stripAudio(inputPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(['-c:v copy', '-an', '-movflags +faststart'])
      .output(outPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
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

  const originalDuration = await getVideoDuration(inputPath);
  let duration = originalDuration;
  const ops = parseInstructions(instructions, duration);
  const outputPath = path.join(sessionDir, 'output.mp4');

  // Passo 1 (opcional): remoção de silêncios → intermediário
  let workingInput = inputPath;
  if (ops.removeSilence) {
    console.log('[FFmpeg] Detectando silêncios...');
    const silences = await detectSilenceSegments(inputPath);
    const silenceFilter = silences.length ? buildSilenceRemoveFilter(silences, duration) : null;
    if (silenceFilter) {
      console.log(`[FFmpeg] ${silences.length} silêncio(s), ${silenceFilter.speechSegments.length} segmento(s) de fala`);
      const noSilencePath = path.join(sessionDir, 'nosilence.mp4');
      await runSilenceRemoval(inputPath, silenceFilter, noSilencePath);
      workingInput = noSilencePath;
      duration = await getVideoDuration(noSilencePath);
    } else {
      console.log('[FFmpeg] Nenhum silêncio relevante detectado');
      ops.removeSilence = false;
    }
  }

  // Passo 2: filtros principais (se legendas, vai para arquivo intermediário)
  const mainOut = ops.subtitles ? path.join(sessionDir, 'stage_main.mp4') : outputPath;

  // Legendas (Whisper) precisam do áudio para transcrever. Se o usuário pediu
  // mudo + legendas, adiamos a remoção do áudio para depois da transcrição —
  // senão o passo principal removeria o áudio e a transcrição falharia
  // ("Output file does not contain any stream"). O mute é aplicado ao queimar
  // as legendas (ou no fallback abaixo).
  const deferMute = ops.mute && ops.subtitles;
  const mainOps = deferMute ? { ...ops, mute: false } : ops;
  await runMainPass(workingInput, mainOps, duration, mainOut);

  // Passo 3 (opcional, best-effort): legendas via Whisper
  if (ops.subtitles) {
    try {
      console.log('[FFmpeg] Transcrevendo áudio para legendas...');
      const srtPath = await transcribeToSrt(mainOut, sessionDir);
      await burnSubtitles(mainOut, srtPath, outputPath, { muteAudio: deferMute });
    } catch (e) {
      console.error('[FFmpeg] Falha ao gerar legendas:', e.message);
      // Não derruba a edição inteira — entrega o vídeo sem legenda e avisa.
      // Se o mute foi adiado, mainOut ainda tem áudio: removemos agora para
      // respeitar o pedido de mudo do usuário.
      if (deferMute) await stripAudio(mainOut, outputPath);
      else fs.copyFileSync(mainOut, outputPath);
      ops.subtitles = false;
      ops.subtitles_warning = e.message;
    }
  }

  const finalDuration = await getVideoDuration(outputPath);
  const stat = fs.statSync(outputPath);
  return {
    outputPath,
    sessionDir,
    duration_original: Math.round(originalDuration),
    duration_output: Math.round(finalDuration),
    size_mb: (stat.size / 1_048_576).toFixed(2),
    ops_applied: ops,
  };
}

module.exports = { editVideo };

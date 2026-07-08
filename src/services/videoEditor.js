const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const https = require('https');
const http = require('http');
const { isDriveUrl, downloadFromDrive } = require('./driveDownloader');
const VE = require('./videoEnhance');

// Diretório de fontes embarcadas (Dockerfile instala fonts-liberation).
// Sobrescrevível por FONTS_DIR. Garante que o libass ache "Liberation Sans".
const FONTS_DIR = process.env.FONTS_DIR || '/usr/share/fonts/truetype/liberation';

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

// Base de tmp. Se VIDEO_TMP_DIR (ou volume do Railway) estiver setado, os
// arquivos sobrevivem a restart/deploy. Sem env → comportamento atual.
const TMP_DIR = process.env.VIDEO_TMP_DIR
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'video-tmp') : path.join(__dirname, '../../tmp'));
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

// Dimensões do vídeo (W,H) — usado p/ formatar a legenda ASS conforme vertical/horizontal
function getVideoDims(inputPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, meta) => {
      if (err || !meta) return resolve({ w: null, h: null });
      const v = (meta.streams || []).find(s => s.codec_type === 'video');
      resolve({ w: v?.width || null, h: v?.height || null });
    });
  });
}

function parseInstructions(instructions, duration) {
  const ops = {
    trim: null,
    resize: null,
    subtitles: false,
    removeSilence: false,
    trimEdgesOnly: false,
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

  if (text.match(/legend(?:a|as|e|ar|ado|ados)?|caption|subtitle|srt/)) ops.subtitles = true;
  // Remoção de pausas reage ao SUBSTANTIVO "silêncio(s)" (lacunas sem fala)
  if (text.match(/paus[as]|silencio|silence|cortar\s+paus/i)) ops.removeSilence = true;

  // Modo controlado para reels gravados em takes: apara só o vazio antes da
  // primeira fala e depois da última, sem cortar respiros no meio do roteiro.
  if (text.match(/aparar\s+bordas|cortar\s+bordas|trim\s+edges|edge\s+trim|(?:so|somente|apenas).*(?:inicio|come[cç]o).*(?:fim|final)|(?:inicio|come[cç]o).*(?:fim|final).*(?:so|somente|apenas)/)) {
    ops.trimEdgesOnly = true;
    ops.removeSilence = false;
  }

  // Opt-outs explícitos (cut e legenda são padrão, então é preciso poder desligar)
  if (text.match(/sem\s+legenda|nao\s+(?:quero\s+)?legenda|sem\s+caption/)) ops.subtitles = false;
  if (text.match(/sem\s+cort|nao\s+cort|mant(?:er|enha)\s+(?:as\s+)?paus|sem\s+remover\s+paus/)) ops.removeSilence = false;

  // Velocidade: "velocidade 1.1", "1.1x"/"2x" (sem ser resize tipo 9x16),
  // "acelerar 10%"/"10% mais rápido" (→1.1), "reduzir 10%"/"10% mais devagar" (→0.9).
  // text já está sem acento (rápido→rapido). atempo do ffmpeg cobre 0.5–2.0 (1.1 ok).
  let speedVal = null, sm;
  if ((sm = text.match(/velocidade\s+(\d+(?:[.,]\d+)?)/))) speedVal = parseFloat(sm[1].replace(',', '.'));
  else if ((sm = text.match(/(\d+(?:[.,]\d+)?)\s*[x×](?!\s*\d)/))) speedVal = parseFloat(sm[1].replace(',', '.'));
  else if ((sm = text.match(/acelerar(?:\s+em)?\s+(\d+)\s*%/)) || (sm = text.match(/(\d+)\s*%\s*mais\s+rapid/))) speedVal = 1 + parseFloat(sm[1]) / 100;
  else if ((sm = text.match(/(?:desacelerar|reduzir|diminuir)(?:\s+em)?\s+(\d+)\s*%/)) || (sm = text.match(/(\d+)\s*%\s*mais\s+(?:devagar|lent)/))) speedVal = 1 - parseFloat(sm[1]) / 100;
  if (speedVal !== null) ops.speed = Math.min(2.0, Math.max(0.5, speedVal));

  // Mute reage ao VERBO "silenciar/silencie" (não ao substantivo "silêncio",
  // que é remoção de pausas) — evita que "cortar os silêncios" tire todo o áudio.
  if (text.match(/sem\s+(?:audio|som)|(?:tirar|remover)\s+(?:o\s+)?(?:audio|som)|mudo|mute|silenci[ae]/i)) ops.mute = true;
  else {
    // aceita "volume: 50%", "volume 50%", "volume para/pra/a/de 50%"
    const volMatch = text.match(/volume\s*(?:para|pra|a|de|:)?\s*(\d+)\s*%/i);
    if (volMatch) ops.volume = parseFloat(volMatch[1]) / 100;
  }

  if (text.match(/preto\s+e\s+branco|grayscale|cinza|b&w/i)) ops.grayscale = true;

  // Zoom de retenção (opt-in): só quando pedido explicitamente.
  if (text.match(/zoom|dinamic|retenc|movimento|pattern\s*interrupt/i)) ops.autoZoom = true;

  return ops;
}

function parseEditFlags(flags = {}) {
  const captionColor = String(flags.captionColor || 'yellow').toLowerCase() === 'white' ? 'white' : 'yellow';
  const visualHook = String(flags.visualHook || '').trim().slice(0, 120);
  const hookDuration = Math.min(7, Math.max(3, Number(flags.visualHookDurationS) || 5));
  const ops = {
    trim: null,
    resize: null,
    subtitles: Boolean(flags.subtitles),
    removeSilence: false,
    trimEdgesOnly: Boolean(flags.trimEdgesOnly),
    captionColor,
    visualHook,
    visualHookDurationS: hookDuration,
    speed: null,
    volume: null,
    mute: false,
    grayscale: false,
  };

  const pauseCut = String(flags.pauseCut || 'none').toLowerCase();
  if (pauseCut === 'suave' || pauseCut === 'agressivo') {
    ops.removeSilence = true;
    ops.trimEdgesOnly = false;
  }

  const speed = Number(flags.speed);
  if (speed === 1.1 || speed === 1.2) ops.speed = speed;

  const volume = Number(flags.volume);
  if ([1.1, 1.2, 1.3, 1.5].includes(volume)) ops.volume = volume;

  const resize = String(flags.resize || '').trim();
  if (['9:16', '1:1', '16:9'].includes(resize)) ops.resize = resize;

  return ops;
}

// Corte de pausas (Fase 1): só corta pausas LONGAS e deixa um respiro, em vez de
// remover tudo pra zero (que gera jump cut e mata o ritmo da fala).
const SILENCE_MIN_S = 1.2;  // (legado) usado só pelo fallback buildSilenceRemoveFilter
const KEEP_PAUSE_S = 0.4;   // ao cortar, mantém 400ms de pausa (não corta pra zero)
// Detecção acústica: limiar BAIXO (0.25s) p/ surgir pausas curtas — quem decide
// o que cortar é o detectJumpCuts (minGap por nível de agressividade). dBFS configurável.
const SILENCE_DETECT_S = +(process.env.SILENCE_DETECT_S || 0.25);
const SILENCE_DETECT_DB = +(process.env.SILENCE_DBFS || -32);
const EDGE_TRIM_PAD_S = +(process.env.EDGE_TRIM_PAD_S || 0.10);

// Detecta segmentos de silêncio e retorna lista de intervalos com fala
function detectSilenceSegments(inputPath) {
  return new Promise((resolve, reject) => {
    const silences = [];
    let stderr = '';
    ffmpeg(inputPath)
      .audioFilters(`silencedetect=noise=${SILENCE_DETECT_DB}dB:d=${SILENCE_DETECT_S}`)
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

function buildEdgeTrimFromWords(words, duration) {
  const ws = (Array.isArray(words) ? words : [])
    .filter(w => Number.isFinite(+w.start) && Number.isFinite(+w.end))
    .sort((a, b) => a.start - b.start);
  if (!ws.length) return null;

  const start = Math.max(0, ws[0].start - EDGE_TRIM_PAD_S);
  const end = Math.min(duration, ws[ws.length - 1].end + EDGE_TRIM_PAD_S);
  if (end - start < 0.25) return null;
  return { start: +start.toFixed(3), end: +end.toFixed(3) };
}

function remapWordsForTrim(words, trim) {
  if (!trim || !Array.isArray(words) || !words.length) return words;
  return words
    .filter(w => w.end > trim.start && w.start < trim.end)
    .map(w => ({
      ...w,
      start: Math.max(0, w.start - trim.start),
      end: Math.max(0, w.end - trim.start),
    }));
}

// Constrói filtro FFmpeg encurtando cada pausa longa para KEEP_PAUSE_S (deixando
// metade do respiro de cada lado), em vez de removê-la por completo.
function buildSilenceRemoveFilter(silences, duration) {
  const half = KEEP_PAUSE_S / 2;
  const speechSegments = [];
  let cursor = 0;
  for (const s of silences) {
    const start = s.start ?? 0;
    const end   = s.end   ?? duration;
    // mantém ~half após a última palavra (respiração natural)
    const segEnd = Math.min(start + half, end);
    if (segEnd > cursor + 0.1) speechSegments.push({ start: cursor, end: segEnd });
    // próximo trecho começa ~half antes da próxima palavra → sobra KEEP_PAUSE_S de pausa
    cursor = Math.max(end - half, segEnd);
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

// Legendas inteligentes — regras de exibição
const CAP_MAX_WORDS = 7;     // máx. palavras por legenda
const CAP_MIN_S = 0.8;       // tempo mínimo de exibição
const CAP_MAX_S = 3.5;       // tempo máximo de exibição
const CAP_GAP_S = 0.05;      // folga mínima entre legendas

function secToSrtTime(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(sec)},${p(ms, 3)}`;
}

// Agrupa palavras (com timestamp) em legendas inteligentes: ≤7 palavras, quebra
// em unidade de sentido (pontuação), 800–3500ms, sincronizadas na 1ª palavra.
function buildCaptionSrt(words) {
  const ws = (Array.isArray(words) ? words : [])
    .map(w => ({ text: VE.cleanWordToken(w.word ?? w.text), start: Number(w.start), end: Number(w.end) }))
    .filter(w => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
  if (ws.length === 0) return '';

  const cues = [];
  let cur = [];
  const flush = () => { if (cur.length) { cues.push(cur); cur = []; } };

  for (const w of ws) {
    cur.push(w);
    const endsSentence = /[.!?…]$/.test(w.text);
    const dur = w.end - cur[0].start;
    if (endsSentence) { flush(); continue; }
    if (cur.length >= CAP_MAX_WORDS || dur >= CAP_MAX_S) {
      // prefere quebrar na última vírgula/cláusula da janela (unidade de sentido)
      let idx = -1;
      for (let i = cur.length - 2; i >= 1; i--) { if (/[,;:]$/.test(cur[i].text)) { idx = i; break; } }
      if (idx >= 1) { const rest = cur.slice(idx + 1); cues.push(cur.slice(0, idx + 1)); cur = rest; }
      else flush();
    }
  }
  flush();

  const blocks = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const start = c[0].start;
    let end = c[c.length - 1].end;
    if (end - start > CAP_MAX_S) end = start + CAP_MAX_S;        // teto
    if (end - start < CAP_MIN_S) end = start + CAP_MIN_S;        // piso
    const nextStart = cues[i + 1] ? cues[i + 1][0].start : Infinity;
    if (end > nextStart - CAP_GAP_S) end = Math.max(start + 0.3, nextStart - CAP_GAP_S); // sem sobrepor
    const text = c.map(w => w.text).join(' ');
    blocks.push(`${i + 1}\n${secToSrtTime(start)} --> ${secToSrtTime(end)}\n${text}`);
  }
  return blocks.length ? blocks.join('\n\n') + '\n' : '';
}

// Transcreve e devolve as PALAVRAS cruas do Whisper (word-level) + granularidade.
// Reutilizável tanto para legendas quanto para detecção de jump cut.
async function transcribeWords(videoPath, sessionDir) {
  const openai = getOpenAI();
  if (!openai) throw new Error('Transcrição exige OPENAI_API_KEY configurada no ambiente');
  if (!(await hasAudioStream(videoPath)))
    throw new Error('o vídeo não tem faixa de áudio para transcrever');

  const audioPath = path.join(sessionDir, `audio_${Date.now()}.mp3`);
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath).noVideo().audioCodec('libmp3lame').audioBitrate('128k')
      .output(audioPath).on('end', resolve).on('error', reject).run();
  });

  const resp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: process.env.WHISPER_MODEL || 'whisper-1',
    response_format: 'verbose_json',
    // 'segment' traz o texto COM pontuação → fronteiras de frase confiáveis
    timestamp_granularities: ['word', 'segment'],
    language: 'pt',
  });
  try { fs.unlinkSync(audioPath); } catch {}

  const granularity = VE.detectTimestampGranularity(resp || {});
  let words = VE.flattenWords(resp || {});
  if (!words.length && Array.isArray(resp?.segments)) words = VE.approxWordsFromSegments(resp.segments);
  // marca fim de frase combinando token + segmentos pontuados + pausas
  words = VE.markSentenceEnds(words, resp?.segments || []);
  const nSent = words.filter(w => w.sentenceEnd).length;
  console.log(`[Whisper] granularidade=${granularity} | ${words.length} palavras | ${nSent} fim-de-frase`);
  return { words, granularity };
}

async function transcribeToSrt(videoPath, sessionDir) {
  const { words } = await transcribeWords(videoPath, sessionDir);
  const srt = buildCaptionSrt(words);

  // Filtra alucinações do Whisper (Amara.org etc.). Se não sobrar legenda real,
  // é áudio sem fala — falha de propósito para entregar o vídeo sem legenda.
  const cleaned = cleanSrtHallucinations(srt);
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
    // Fontsize relativo à altura de script do libass (~288): 10 ≈ 3.3% da altura.
    // Cor creme #F8F4EE → ASS é &HAABBGGRR (BGR!) → &H00EEF4F8.
    // Posição: terço inferior (MarginV=60) — abaixo do rosto e acima da legenda/handle
    // do Instagram; MarginL/R=70 mantêm um bloco central estreito que sai de trás dos
    // botões da direita (curtir/comentar) sem precisar subir até o rosto.
    const style = "force_style='Fontname=Liberation Sans,Fontsize=10,Bold=1,PrimaryColour=&H00EEF4F8,OutlineColour=&H90000000,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginL=70,MarginR=70,MarginV=60'";
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

// Queima legenda .ASS (karaoke por palavra). Copia o .ass para path ASCII-only
// (acento/caractere especial quebra o filtro subtitles silenciosamente) e passa
// fontsdir p/ o libass achar a fonte embarcada.
function burnAss(inputPath, assPath, outPath, { muteAudio = false } = {}) {
  return new Promise((resolve, reject) => {
    // path temporário ASCII-only no mesmo dir
    const safeName = `subs_${Date.now()}.ass`;
    const safePath = path.join(path.dirname(assPath), safeName);
    try { fs.copyFileSync(assPath, safePath); } catch (e) { return reject(e); }

    const escaped = safePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const fontsArg = fs.existsSync(FONTS_DIR) ? `:fontsdir='${FONTS_DIR}'` : '';
    const audioOpts = muteAudio ? ['-an'] : ['-c:a copy'];
    ffmpeg(inputPath)
      .videoFilters(`subtitles='${escaped}'${fontsArg}`)
      .outputOptions(['-c:v libx264', '-preset fast', '-crf 20', ...audioOpts, '-movflags +faststart', '-pix_fmt yuv420p'])
      .output(outPath)
      .on('start', () => console.log('[FFmpeg] Queimando legendas ASS (amarela estática)...'))
      .on('end', () => { try { fs.unlinkSync(safePath); } catch {} resolve(); })
      .on('error', err => { try { fs.unlinkSync(safePath); } catch {} reject(err); })
      .run();
  });
}

// Pipeline de legenda otimizada: resegmenta → revisa PT (LLM) → valida/auto-fix
// → gera ASS karaoke. Cada camada degrada com elegância. Retorna { assPath, report }.
async function buildOptimizedCaptions(words, sessionDir, cfg = {}) {
  const report = { layers: {} };

  // A.1 re-segmentação
  let blocks = VE.resegmentCaptions(words, cfg);
  report.layers.resegment = { blocks: blocks.length };
  if (!blocks.length) throw new Error('re-segmentação não produziu blocos');

  // A.2 revisão PT (best-effort)
  try {
    const rev = await VE.reviewCaptionsPT(blocks, { glossario: cfg.glossario || [], cfg });
    blocks = rev.blocks;
    report.layers.review = { reviewed: rev.reviewed, reason: rev.reason || null };
  } catch (e) { report.layers.review = { reviewed: false, reason: e.message }; }

  // A.3 validação + auto-fix
  let val = VE.validateCaptions(blocks, cfg);
  if (!val.ok) {
    blocks = VE.autoFixCaptions(blocks, cfg);
    val = VE.validateCaptions(blocks, cfg);
  }
  report.layers.validate = { ok: val.ok, issues: val.issues.length };

  // A.4 ASS
  const ass = VE.buildAss(blocks, cfg);
  const assPath = path.join(sessionDir, 'subs.ass');
  fs.writeFileSync(assPath, ass);
  report.captionStarts = blocks.map(b => b.start);
  return { assPath, report, blocks };
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

// Roda um complexFilter genérico com maps dinâmicos (corte frame-accurate →
// recodifica; crf 20 p/ qualidade alta em 1-2min). Usado pelo jump cut dual-signal.
function runComplexConcat(inputPath, filter, maps, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .complexFilter(filter)
      .outputOptions([
        `-map ${maps[0]}`, `-map ${maps[1]}`,
        '-c:v libx264', '-preset fast', '-crf 20',
        '-c:a aac', '-b:a 160k',
        '-movflags +faststart', '-pix_fmt yuv420p',
      ])
      .output(outPath)
      .on('start', () => console.log('[FFmpeg] Jump cut (concat + crossfade)...'))
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function editVideo({ video_url, instructions, edit_flags, cardId, config = {} }) {
  const sessionId = `video_${cardId || 'tmp'}_${Date.now()}`;
  const sessionDir = path.join(TMP_DIR, sessionId);
  fs.mkdirSync(sessionDir);

  const ext = video_url.match(/\.(mp4|mov|webm|avi|mkv)/i)?.[1] || 'mp4';
  const inputPath = path.join(sessionDir, `input.${ext}`);

  if (isDriveUrl(video_url)) await downloadFromDrive(video_url, inputPath);
  else await downloadFile(video_url, inputPath);

  const originalDuration = await getVideoDuration(inputPath);
  let duration = originalDuration;
  const hasFlags = edit_flags && typeof edit_flags === 'object' && !Array.isArray(edit_flags);
  const ops = hasFlags
    ? parseEditFlags(edit_flags)
    : (instructions && instructions.trim())
      ? parseInstructions(instructions, duration)
      : { trim: null, resize: null, subtitles: true, removeSilence: true, trimEdgesOnly: false, speed: null, volume: null, mute: false, grayscale: false };
  const outputPath = path.join(sessionDir, 'output.mp4');

  // Config das camadas (env defaults sobrescrevíveis por chamada). Nível de
  // agressividade do jump cut vem da instrução, se presente.
  const text = (instructions || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  let aggressiveness = process.env.JUMPCUT_AGGRESSIVENESS || 'medio';
  if (hasFlags && ['suave', 'agressivo'].includes(String(edit_flags.pauseCut || '').toLowerCase())) {
    aggressiveness = String(edit_flags.pauseCut).toLowerCase();
  } else if (/agressiv/.test(text)) aggressiveness = 'agressivo';
  else if (/suave|leve/.test(text)) aggressiveness = 'suave';
  const cfg = {
    aggressiveness,
    cpsMax: +(process.env.CAPTION_CPS_MAX || VE.DEFAULTS.cpsMax),
    karaokeColor: process.env.CAPTION_KARAOKE_COLOR || VE.DEFAULTS.karaokeColor,
    captionColor: ops.captionColor === 'white' ? '#FFFFFF' : (process.env.CAPTION_KARAOKE_COLOR || VE.DEFAULTS.karaokeColor),
    visualHook: ops.visualHook || '',
    visualHookDurationS: ops.visualHookDurationS || 5,
    visualHookColor: '#FFFFFF',
    silenceDbfs: +(process.env.SILENCE_DBFS || VE.DEFAULTS.silenceDbfs),
    ...config,
  };

  const report = { whisper: null, jumpcut: null, captions: null, visualRhythm: null, fallbacks: [] };

  // ── Transcrição única do ORIGINAL (serve jump cut + legendas) ──────────────
  // best-effort: se falhar, segue sem words (camadas degradam).
  let words = [];
  if ((ops.subtitles || ops.removeSilence || ops.trimEdgesOnly) && !ops.mute) {
    try {
      const tr = await transcribeWords(inputPath, sessionDir);
      words = tr.words;
      report.whisper = { granularity: tr.granularity, words: words.length };
    } catch (e) {
      report.whisper = { error: e.message };
      report.fallbacks.push(`transcrição original falhou: ${e.message}`);
    }
  }

  if (ops.trimEdgesOnly) {
    const edgeTrim = buildEdgeTrimFromWords(words, duration);
    if (edgeTrim) {
      ops.trim = edgeTrim;
      report.edgeTrim = {
        applied: true,
        start: edgeTrim.start,
        end: edgeTrim.end,
        removed_start_s: +edgeTrim.start.toFixed(2),
        removed_end_s: +(duration - edgeTrim.end).toFixed(2),
      };
    } else {
      report.edgeTrim = { applied: false, reason: 'sem palavras suficientes para detectar começo/fim da fala' };
    }
  }

  // ── Passo 1: Jump cut (dual signal) ────────────────────────────────────────
  let workingInput = inputPath;
  let keepSegments = null;
  if (ops.removeSilence) {
    try {
      console.log('[FFmpeg] Detectando silêncios (silencedetect)...');
      const silences = await detectSilenceSegments(inputPath); // [{start,end}]
      const jc = VE.detectJumpCuts(duration, silences, words, cfg);
      report.jumpcut = jc.stats;

      if (jc.cuts.length && jc.keep.length) {
        const kf = VE.buildKeepFilter(jc.keep, cfg);
        const cutPath = path.join(sessionDir, 'nosilence.mp4');
        try {
          await runComplexConcat(inputPath, kf.filter, kf.maps, cutPath);
        } catch (e) {
          // fallback: caminho antigo (encurta pausas, sem crossfade)
          report.fallbacks.push(`jump cut dual-signal falhou (${e.message}); usando encurtamento simples`);
          const sf = buildSilenceRemoveFilter(silences, duration);
          if (sf) await runSilenceRemoval(inputPath, sf, cutPath);
          else throw e;
        }
        workingInput = cutPath;
        keepSegments = jc.keep;
        duration = await getVideoDuration(cutPath);
        // EDL não-destrutivo
        VE.writeEdl(sessionDir, { source: 'input.' + ext, cuts: jc.cuts, keep: jc.keep, stats: jc.stats });
        // re-mapeia palavras p/ timeline pós-corte
        if (words.length) words = VE.remapWordsThroughKeep(words, jc.keep);
      } else {
        console.log('[FFmpeg] Nenhum corte relevante');
        ops.removeSilence = false;
      }
    } catch (e) {
      report.fallbacks.push(`jump cut falhou: ${e.message}`);
      ops.removeSilence = false;
    }
  }

  // ── Passo 2: filtros principais (resize/speed/grayscale/volume) ────────────
  const mainOut = ops.subtitles ? path.join(sessionDir, 'stage_main.mp4') : outputPath;
  const deferMute = ops.mute && ops.subtitles;
  const mainOps = deferMute ? { ...ops, mute: false } : ops;
  await runMainPass(workingInput, mainOps, duration, mainOut);

  // Trim faz a timeline do vídeo voltar para 0; ajusta as palavras antes de legendar.
  if (ops.trim && words.length) {
    words = remapWordsForTrim(words, ops.trim);
  }

  // velocidade altera o tempo: escala as palavras p/ casar com o vídeo acelerado
  if (ops.speed && ops.speed !== 1.0 && words.length) {
    words = words.map(w => ({ ...w, start: w.start / ops.speed, end: w.end / ops.speed }));
  }

  // ── Passo 3: legendas otimizadas ──────────────────────────────────────────
  // Gera os blocos UMA vez (resegment+revisão+validação). Tenta queimar ASS;
  // se o ASS falhar, queima SRT DOS MESMOS BLOCOS (texto idêntico, limpo) — NÃO
  // cai mais no SRT velho/transcrição crua. Só usa transcrição crua se não
  // houver palavras (transcrição original falhou).
  if (ops.subtitles) {
    let burned = false;
    if (words.length) {
      const dims = await getVideoDims(mainOut);
      const vertical = dims.h && dims.w && dims.h >= dims.w;
      const capCfg = {
        ...cfg, videoW: dims.w, videoH: dims.h,
        maxCharsPerLine: vertical ? 24 : 42,
        maxWords: vertical ? 5 : 7,
        maxLines: 2,
      };
      try {
        const { assPath, blocks, report: capReport } = await buildOptimizedCaptions(words, sessionDir, capCfg);
        // 3a) tenta ASS (karaoke estático amarelo, vertical-aware)
        try {
          await burnAss(mainOut, assPath, outputPath, { muteAudio: deferMute });
          report.captions = { mode: 'ass', ...capReport };
          burned = true;
        } catch (eAss) {
          // 3b) fallback: SRT dos MESMOS blocos otimizados (texto limpo igual)
          report.fallbacks.push(`burn ASS falhou (${eAss.message}); SRT dos blocos otimizados`);
          const srtPath = path.join(sessionDir, 'subs_opt.srt');
          fs.writeFileSync(srtPath, VE.buildSrtFromBlocks(blocks));
          await burnSubtitles(mainOut, srtPath, outputPath, { muteAudio: deferMute });
          report.captions = { mode: 'srt_otimizado', ...capReport, ass_error: eAss.message };
          burned = true;
        }
      } catch (e) {
        report.fallbacks.push(`pipeline de legenda falhou: ${e.message}`);
      }
    }
    if (!burned) {
      // Último recurso: transcrição crua do vídeo final (só se não houve palavras)
      try {
        console.log('[FFmpeg] Último recurso — transcrição crua...');
        const srtPath = await transcribeToSrt(mainOut, sessionDir);
        await burnSubtitles(mainOut, srtPath, outputPath, { muteAudio: deferMute });
        report.captions = { mode: 'srt_cru' };
        burned = true;
      } catch (e) {
        console.error('[FFmpeg] Falha ao gerar legendas:', e.message);
        if (deferMute) await stripAudio(mainOut, outputPath);
        else fs.copyFileSync(mainOut, outputPath);
        ops.subtitles = false;
        ops.subtitles_warning = e.message;
        report.captions = { mode: 'none', error: e.message };
      }
    }
  }

  // ── Ritmo visual (análise) ─────────────────────────────────────────────────
  let stalled = [];
  try {
    const finalDur = await getVideoDuration(outputPath);
    const events = [];
    if (report.captions?.captionStarts) events.push(...report.captions.captionStarts);
    const vr = VE.analyzeVisualRhythm(finalDur, events, cfg);
    report.visualRhythm = vr;
    stalled = vr.trechos_parados || [];
  } catch (e) { report.fallbacks.push(`ritmo visual: ${e.message}`); }

  // ── Zoom de retenção (OPT-IN: só quando pedido) — heurística, sem ML ───────
  if (ops.autoZoom && stalled.length) {
    try {
      const dims = await getVideoDims(outputPath);
      const focalY = dims.h && dims.w && dims.h >= dims.w ? 0.38 : 0.5; // rosto + alto no vertical
      const zf = VE.buildRetentionZoom(stalled, { w: dims.w, h: dims.h, focalY });
      if (zf) {
        const zoomed = path.join(sessionDir, 'zoomed.mp4');
        await new Promise((resolve, reject) => {
          ffmpeg(outputPath)
            .videoFilters(zf)
            .outputOptions(['-c:v libx264', '-preset fast', '-crf 20', '-c:a copy', '-movflags +faststart', '-pix_fmt yuv420p'])
            .output(zoomed)
            .on('start', () => console.log('[FFmpeg] Zoom de retenção (heurística)...'))
            .on('end', resolve).on('error', reject).run();
        });
        fs.copyFileSync(zoomed, outputPath);
        try { fs.unlinkSync(zoomed); } catch {}
        report.zoom = { applied: true, windows: stalled.length, focalY };
      }
    } catch (e) {
      report.fallbacks.push(`zoom de retenção falhou (mantido sem zoom): ${e.message}`);
      report.zoom = { applied: false, error: e.message };
    }
  } else if (ops.autoZoom) {
    report.zoom = { applied: false, reason: 'nenhum trecho parado >2.5s' };
  }

  const finalDuration = await getVideoDuration(outputPath);
  const stat = fs.statSync(outputPath);

  // Limpeza de intermediários (mantém output.mp4 + edl.json). Best-effort.
  try {
    for (const f of fs.readdirSync(sessionDir)) {
      if (f === 'output.mp4' || f === 'edl.json') continue;
      if (/^(input\.|audio_|audio\.|nosilence|stage_main|subs\.|subs_)/.test(f)) {
        try { fs.unlinkSync(path.join(sessionDir, f)); } catch {}
      }
    }
  } catch {}

  return {
    outputPath,
    sessionDir,
    duration_original: Math.round(originalDuration),
    duration_output: Math.round(finalDuration),
    size_mb: (stat.size / 1_048_576).toFixed(2),
    ops_applied: ops,
    enhance_report: report,
  };
}

module.exports = { editVideo, TMP_DIR };

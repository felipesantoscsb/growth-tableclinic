/**
 * videoEnhance.js — camadas de otimização do módulo de edição de vídeo.
 *
 * Mantém videoEditor.js estável; cada função aqui é tolerante a falha e
 * pensada para DEGRADAR com elegância (o chamador mantém o resultado anterior
 * se uma camada lançar). Tudo configurável via objeto `cfg`.
 *
 * Whisper: o projeto usa OpenAI whisper-1 com timestamp_granularities:['word']
 * → output WORD_LEVEL (resp.words = [{word,start,end}]). Sem necessidade de
 * upgrade/WhisperX (que exigiria runtime Python). Quando word-level não estiver
 * disponível, as camadas caem para aproximação por segmento (documentado).
 */
const fs = require('fs');
const path = require('path');

// ── Config padrão (tudo sobrescrevível por chamada) ─────────────────────────
const DEFAULTS = {
  // Legendas
  cpsMax: 17,
  cpsIdealLow: 12,
  cpsIdealHigh: 15,
  maxCharsPerLine: 42,
  maxLines: 2,
  maxWords: 6,                 // teto de palavras por bloco (legenda punchy)
  blockMinS: 1.0,
  blockMaxS: 5.0,
  karaokeColor: '#FFEE00',     // amarelo da legenda (gold #FFD700 lia como laranja no vídeo)
  primaryColor: '#FFFFFF',     // texto base
  fontName: 'Liberation Sans',
  // Jump cut
  silenceDbfs: -35,            // limiar de energia
  padBeforeS: 0.06,            // padding de segurança antes/depois da fala
  padAfterS: 0.06,
  crossfadeMs: 12,             // micro-crossfade de áudio nas emendas
  // níveis de agressividade → limiar de duração de silêncio p/ corte
  aggressiveness: 'medio',     // suave | medio | agressivo
  // Ritmo visual
  visualIdealLowS: 1.2,
  visualIdealHighS: 2.0,
  visualSlowS: 2.5,
};

// Limiar de duração de pausa p/ cortar, por nível. Apertado: pega pausinhas.
const AGGRESSION_GAP_S = { suave: 0.55, medio: 0.35, agressivo: 0.25 };

// Hesitações comuns em PT (palavra isolada e curta) — remoção opcional/agressiva
const HESITATIONS = new Set(['é', 'éé', 'ééé', 'ã', 'ãã', 'ãn', 'hum', 'hmm', 'aham', 'ahn', 'eh', 'né', 'tipo', 'então']);

// ════════════════════════════════════════════════════════════════════════════
// Zona segura das plataformas (Meta Reels / Stories)
// ════════════════════════════════════════════════════════════════════════════
// Frações da tela reservadas pela UI do app — texto ali dentro corre risco de
// ficar coberto. Em 1080x1920 dá: topo 250px (barra de perfil/rótulo de anúncio),
// base 422px (legenda do post + botão de CTA), esquerda 65px, direita 140px
// (coluna de curtir/comentar/enviar).
// O template oficial da Meta fala em "manter o essencial dentro de 1080x1420" —
// isso vale para elemento solto no meio da tela. A legenda fica ANCORADA na base,
// justamente onde ficam legenda do post e botão, então aqui usamos o recuo real
// da UI (422px) em vez dos 250px simétricos do template.
// Tudo sobrescrevível por env p/ calibrar sem mexer em código.
const SAFE_ZONES = {
  reels: {
    top:    +(process.env.SAFE_TOP    || 0.130),
    bottom: +(process.env.SAFE_BOTTOM || 0.220),
    left:   +(process.env.SAFE_LEFT   || 0.060),
    right:  +(process.env.SAFE_RIGHT  || 0.130),
  },
  // formatos não-verticais (feed 1:1 / 16:9): só um respiro nas bordas
  feed: { top: 0.06, bottom: 0.10, left: 0.06, right: 0.06 },
};

// Limite de caracteres do hook visual (recomendação Meta: leitura em <1s).
const HOOK_MAX_CHARS = +(process.env.HOOK_MAX_CHARS || 40);

// Converte o preset em pixels para um vídeo WxH. Os lados viram SIMÉTRICOS
// (max(esquerda, direita)) p/ o texto continuar centralizado e ainda assim
// escapar da coluna de ações da direita.
function resolveSafeZone(W, H, preset) {
  const key = SAFE_ZONES[preset] ? preset : 'reels';
  const z = SAFE_ZONES[key];
  const side = Math.round(W * Math.max(z.left, z.right));
  const top = Math.round(H * z.top);
  const bottom = Math.round(H * z.bottom);
  return { preset: key, top, bottom, side, boxW: W - side * 2, boxH: H - top - bottom };
}

// Palavras que marcam a entrada em oferta/produto (no nosso caso, quase sempre
// o QUIZ). Sem acento — o texto é normalizado antes de casar.
const OFFER_KEYWORDS = /(quiz|teste|testar|clique|clica|clicar|link|bio|gratuit|gratis|formulario|cadastr|acess|descubr|descobr|arrast|abaixo|comec[ae] agora)/;

// Acha o instante em que o vídeo "vira" para a oferta. Procura a 1ª palavra-chave
// na parte final do vídeo e recua até o começo da frase, p/ o corte cair na
// entrada da fala e não no meio dela. Retorna { at, keyword, word } ou null.
function detectOfferMoment(words, duration, { searchFrom = 0.4, maxBackWords = 14, padS = 0.12 } = {}) {
  const ws = (words || []).filter(w => w && w.text && Number.isFinite(w.start));
  if (!ws.length || !(duration > 0)) return null;
  const floor = duration * searchFrom;
  const norm = t => String(t).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  let hit = -1, keyword = null;
  for (let i = 0; i < ws.length; i++) {
    if (ws[i].start < floor) continue;
    const m = norm(ws[i].text).match(OFFER_KEYWORDS);
    if (m) { hit = i; keyword = m[0]; break; }
  }
  if (hit < 0) return null;
  // recua até o início da frase (fronteira de sentença ou pausa)
  let j = hit;
  for (let n = 0; n < maxBackWords && j > 0; n++) {
    const prev = ws[j - 1];
    if (prev.sentenceEnd) break;
    if (ws[j].start - prev.end >= 0.35) break;
    j--;
  }
  const at = Math.max(0, ws[j].start - padS);
  return { at: +at.toFixed(3), keyword, word: ws[hit].text };
}

// Corte seco = reenquadramento INSTANTÂNEO em `atS` (sem rampa), mantido até o
// fim. Lido como pattern interrupt na entrada da oferta. Mesma técnica do zoom
// de retenção (crop+scale), só que degrau em vez de rampa.
function buildHardCutFilter(atS, { w, h, to = 1.10, focalY = 0.42 } = {}) {
  if (!(atS > 0) || !w || !h) return null;
  const t = Number(atS).toFixed(3);
  const z = `if(gte(t\\,${t})\\,${Number(to).toFixed(3)}\\,1.0)`;
  const cw = `iw/(${z})`;
  const ch = `ih/(${z})`;
  const cx = `(iw-${cw})*0.5`;
  const cy = `(ih-${ch})*${Number(focalY).toFixed(3)}`;
  return `crop=w='${cw}':h='${ch}':x='${cx}':y='${cy}',scale=${w}:${h}`;
}

// ════════════════════════════════════════════════════════════════════════════
// A.0 — Detecção de granularidade
// ════════════════════════════════════════════════════════════════════════════
function detectTimestampGranularity(whisperOutput) {
  const o = whisperOutput || {};
  if (Array.isArray(o.words) && o.words.length && o.words.every(w => Number.isFinite(w.start) && Number.isFinite(w.end))) {
    return 'word_level';
  }
  if (Array.isArray(o.segments) && o.segments.some(s => Array.isArray(s.words) && s.words.length)) {
    return 'word_level';
  }
  return 'segment_only';
}

// Limpa um TOKEN de palavra do Whisper: tira pontuação/espaço solto no INÍCIO
// (o whisper-1 às vezes devolve ",palavra" colado) mas preserva o final (",", ".").
function cleanWordToken(raw) {
  return stripLeadingPunct(String(raw ?? '')).trim();
}

// Normaliza qualquer shape do Whisper para uma lista plana de palavras {text,start,end}
function flattenWords(whisperOutput) {
  const o = whisperOutput || {};
  if (Array.isArray(o.words) && o.words.length) {
    return o.words
      .map(w => ({ text: cleanWordToken(w.word ?? w.text), start: +w.start, end: +w.end }))
      .filter(w => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
  }
  if (Array.isArray(o.segments)) {
    const out = [];
    for (const s of o.segments) {
      if (Array.isArray(s.words) && s.words.length) {
        for (const w of s.words) {
          const t = cleanWordToken(w.word ?? w.text);
          if (t && Number.isFinite(+w.start) && Number.isFinite(+w.end)) out.push({ text: t, start: +w.start, end: +w.end });
        }
      }
    }
    return out;
  }
  return [];
}

// Aproxima palavras a partir de segmentos (segment_only): distribui o tempo do
// segmento proporcionalmente ao nº de caracteres de cada palavra. APROXIMAÇÃO.
function approxWordsFromSegments(segments) {
  const out = [];
  for (const s of (segments || [])) {
    const text = String(s.text || '').trim();
    if (!text || !Number.isFinite(+s.start) || !Number.isFinite(+s.end)) continue;
    const toks = text.split(/\s+/);
    const totalChars = toks.reduce((a, t) => a + t.length, 0) || 1;
    const span = (+s.end) - (+s.start);
    let cursor = +s.start;
    for (const tok of toks) {
      const dur = span * (tok.length / totalChars);
      out.push({ text: tok, start: cursor, end: cursor + dur, approx: true });
      cursor += dur;
    }
  }
  return out;
}

// Marca fim de frase nas palavras. O whisper-1 às vezes NÃO põe pontuação nos
// tokens de palavra (fica só no texto do segmento). Então combina 3 sinais:
//  1) o próprio token termina em .!?…
//  2) o segmento (que tem pontuação) termina em .!?… → marca a última palavra dele
//  3) pausa longa entre palavras (gapEndS) → fronteira natural de fala
// Grava w.sentenceEnd=true (sobrevive ao remap de corte).
function markSentenceEnds(words, segments, { gapEndS = 0.6 } = {}) {
  const ws = words || [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (/[.!?…]$/.test(w.text)) w.sentenceEnd = true;
    const next = ws[i + 1];
    if (next && (next.start - w.end) >= gapEndS) w.sentenceEnd = true; // pausa = fim de fala
  }
  // segmentos com pontuação final → marca a ÚLTIMA palavra que COMEÇA dentro do
  // segmento. Comparar pelo start (não pelo end): o end da última palavra costuma
  // ultrapassar o end do segmento (marcaria uma palavra antes), e a tolerância no
  // end pegava a 1ª palavra curta da frase SEGUINTE (start ≈ segEnd) — ambos
  // deslocavam a fronteira em ±1 palavra e a legenda "roubava" palavra do trecho
  // vizinho.
  for (const s of (segments || [])) {
    const t = String(s.text || '').trim();
    if (!/[.!?…]$/.test(t)) continue;
    const segEnd = +s.end;
    if (!Number.isFinite(segEnd)) continue;
    let idx = -1;
    for (let i = 0; i < ws.length; i++) { if (ws[i].start < segEnd - 0.02) idx = i; else break; }
    if (idx >= 0) ws[idx].sentenceEnd = true;
  }
  return ws;
}

// ════════════════════════════════════════════════════════════════════════════
// A.1 — Re-segmentação por ritmo de leitura
// ════════════════════════════════════════════════════════════════════════════
const CONJ_PREP = new Set(['e', 'mas', 'que', 'porque', 'porém', 'porem', 'então', 'entao', 'pois', 'se', 'quando', 'como', 'para', 'pra', 'por', 'com', 'sem', 'de', 'em', 'a', 'o']);
const NO_BREAK_AFTER = new Set(['a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'pra', 'com', 'sem', 'ao', 'à']);

function cps(text, durS) {
  const len = text.replace(/\s/g, '').length;
  return durS > 0 ? len / durS : Infinity;
}

// Quebra a lista de palavras em blocos respeitando CPS, chars/linha, duração e
// fronteiras sintáticas. Retorna [{words, start, end, text, lines}].
// Limpa pontuação solta no INÍCIO do bloco (vírgula/ponto-e-vírgula órfãos que
// sobram quando uma frase longa é subdividida) e espaços duplicados.
// Remove no INÍCIO: espaço + pontuação (\p{P}) + MARCAS combinantes órfãs (\p{M},
// ex: cedilha/vírgula-abaixo U+0327 que o Whisper-PT às vezes emite e renderiza
// como vírgula colada) + caracteres de controle/format/zero-width (\p{C}, BOM).
// NFC normaliza primeiro p/ colapsar sequências decompostas (é = e+´ → é).
function stripLeadingPunct(t) {
  return String(t || '').normalize('NFC').replace(/^[\s\p{P}\p{M}\p{C}​-‏﻿]+/u, '');
}
function cleanBlockText(t) {
  return stripLeadingPunct(String(t || '')).replace(/\s+/g, ' ').trim();
}

// SENTENÇA-PRIMEIRO: nenhum bloco cruza fronteira de frase. Agrupa palavras em
// frases (terminam em .!?…); cada frase vira 1+ blocos. Frase que cabe = 1 bloco;
// frase longa é subdividida internamente em vírgula/conjunção, respeitando o
// teto de palavras/chars. A última legenda de uma frase fecha exatamente onde a
// fala termina (encaixe), e a próxima começa já com a frase nova.
function resegmentCaptions(words, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const ws = (words || []).filter(w => w.text);
  if (!ws.length) return [];

  const text = arr => arr.map(w => w.text).join(' ');

  // 1) quebra em frases
  const sentences = [];
  let cur = [];
  for (const w of ws) {
    cur.push(w);
    if (w.sentenceEnd || /[.!?…]$/.test(w.text)) { sentences.push(cur); cur = []; }
  }
  if (cur.length) sentences.push(cur);

  // 2) subdivide cada frase em blocos (sem cruzar a fronteira da frase)
  const blocks = [];
  for (const sent of sentences) {
    const fits = sent.length <= c.maxWords && text(sent).length <= c.maxCharsPerLine * c.maxLines;
    if (fits) { blocks.push(sent); continue; }

    let seg = [];
    const flushSeg = () => { if (seg.length) { blocks.push(seg); seg = []; } };
    for (let i = 0; i < sent.length; i++) {
      seg.push(sent[i]);
      const charCount = text(seg).length;
      const tooMany = seg.length >= c.maxWords;
      const tooLong = charCount > c.maxCharsPerLine * c.maxLines;
      const atWeakPunct = /[,;:]$/.test(sent[i].text) && seg.length >= 2;
      const last = i === sent.length - 1;
      if (last) { flushSeg(); break; }
      if (tooMany || tooLong) {
        // tenta recuar até a última pontuação fraca da janela (quebra natural)
        let cutAt = -1;
        for (let j = seg.length - 2; j >= 1; j--) { if (/[,;:]$/.test(seg[j].text)) { cutAt = j; break; } }
        if (cutAt >= 1) { blocks.push(seg.slice(0, cutAt + 1)); seg = seg.slice(cutAt + 1); }
        else flushSeg();
      } else if (atWeakPunct && seg.length >= Math.ceil(c.maxWords * 0.6)) {
        flushSeg(); // quebra confortável em vírgula quando já tem corpo
      }
    }
    flushSeg();
  }

  // 3) materializa blocos: tempos, duração mín/máx, texto limpo, linhas
  const out = [];
  for (const arr of blocks) {
    if (!arr.length) continue;
    const start = arr[0].start;
    let end = arr[arr.length - 1].end;
    if (end - start < c.blockMinS) end = start + c.blockMinS;
    if (end - start > c.blockMaxS) end = start + c.blockMaxS;
    const txt = cleanBlockText(text(arr));
    if (!txt) continue;
    out.push({ words: arr, start, end, text: txt, lines: wrapLines(txt, c.maxCharsPerLine, c.maxLines) });
  }
  return out;
}

// Quebra texto em até maxLines linhas de até maxChars, sem cortar palavra.
function wrapLines(text, maxChars, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  // se passar de maxLines, junta o excedente na última (validação pega depois)
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    const tail = lines.slice(maxLines - 1).join(' ');
    return [...head, tail];
  }
  return lines;
}

// ════════════════════════════════════════════════════════════════════════════
// A.2 — Revisão de português via LLM (Anthropic Haiku)
// ════════════════════════════════════════════════════════════════════════════
let _anthropic = null;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 40_000, maxRetries: 2 });
  return _anthropic;
}

// Modelo: Haiku por custo/velocidade (revisão é tarefa simples de correção).
// Sobrescrevível por CAPTION_REVIEW_MODEL.
const REVIEW_MODEL = process.env.CAPTION_REVIEW_MODEL || 'claude-3-5-haiku-latest';

// Revisa o texto dos blocos preservando contagem e timestamps. Em qualquer
// falha/divergência de contagem → retorna os blocos originais (nunca quebra).
async function reviewCaptionsPT(blocks, { glossario = [], cfg = {} } = {}) {
  const cc = { ...DEFAULTS, ...cfg };
  const client = getAnthropic();
  if (!client || !blocks.length) return { blocks, reviewed: false, reason: client ? 'sem blocos' : 'ANTHROPIC_API_KEY ausente' };

  const payload = blocks.map((b, i) => ({ id: i + 1, texto: b.text }));
  const glossTxt = glossario.length ? `\nGlossário (mantenha estes termos exatos): ${glossario.join(', ')}.` : '';
  const system = `Você revisa legendas em português (transcrição de fala). Corrija APENAS: pontuação, maiúsculas, números, valores em R$, siglas e erros óbvios de transcrição. NUNCA reescreva, resuma, traduza ou mude o sentido. Mantenha exatamente o que foi dito.${glossTxt}
Responda SOMENTE com JSON válido, mesma quantidade de itens, no formato: [{"id":1,"texto":"..."}]`;

  try {
    const msg = await client.messages.create({
      model: REVIEW_MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: `Revise:\n${JSON.stringify(payload, null, 0)}` }],
    });
    const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { const m = clean.match(/\[[\s\S]*\]/); parsed = m ? JSON.parse(m[0]) : null; }

    if (!Array.isArray(parsed) || parsed.length !== blocks.length) {
      return { blocks, reviewed: false, reason: `contagem divergente (${parsed?.length} vs ${blocks.length})` };
    }
    // Aplica texto revisado preservando words/timestamps; re-wrap linhas
    const byId = new Map(parsed.map(p => [Number(p.id), String(p.texto || '')]));
    const reviewed = blocks.map((b, i) => {
      const novo = cleanBlockText(byId.get(i + 1));
      if (!novo) return b;
      return { ...b, text: novo, lines: wrapLines(novo, cc.maxCharsPerLine, cc.maxLines) };
    });
    return { blocks: reviewed, reviewed: true };
  } catch (e) {
    return { blocks, reviewed: false, reason: e.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// A.3 — Validação (gate antes do render) — com auto-fix opcional
// ════════════════════════════════════════════════════════════════════════════
function validateCaptions(blocks, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const issues = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const dur = b.end - b.start;
    const blockCps = cps(b.text, dur);
    const tc = `${b.start.toFixed(2)}s`;
    if (blockCps > c.cpsMax) issues.push({ i, nivel: 'erro', regra: 'cps', detalhe: `${blockCps.toFixed(1)} CPS (>${c.cpsMax})`, tc });
    else if (blockCps > c.cpsIdealHigh) issues.push({ i, nivel: 'alerta', regra: 'cps', detalhe: `${blockCps.toFixed(1)} CPS`, tc });
    if (dur < c.blockMinS) issues.push({ i, nivel: 'erro', regra: 'duracao', detalhe: `${dur.toFixed(2)}s (<${c.blockMinS})`, tc });
    if ((b.lines || []).some(l => l.length > c.maxCharsPerLine)) issues.push({ i, nivel: 'erro', regra: 'linha', detalhe: `linha >${c.maxCharsPerLine} chars`, tc });
    if ((b.lines || []).length > c.maxLines) issues.push({ i, nivel: 'erro', regra: 'linhas', detalhe: `${b.lines.length} linhas (>${c.maxLines})`, tc });
    const next = blocks[i + 1];
    if (next && b.end > next.start + 0.001) issues.push({ i, nivel: 'erro', regra: 'overlap', detalhe: 'sobreposição', tc });
  }
  return { ok: !issues.some(x => x.nivel === 'erro'), issues };
}

// Auto-fix: estende durações curtas, remove overlaps. Não conserta CPS alto
// (isso exigiria re-segmentar/encurtar texto — feito na re-segmentação).
function autoFixCaptions(blocks, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const out = blocks.map(b => ({ ...b }));
  for (let i = 0; i < out.length; i++) {
    const b = out[i];
    if (b.end - b.start < c.blockMinS) b.end = b.start + c.blockMinS;
    const next = out[i + 1];
    if (next && b.end > next.start) b.end = Math.max(b.start + 0.3, next.start - 0.02);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// A.4 — Geração de ASS com karaoke (palavra ativa colorida)
// ════════════════════════════════════════════════════════════════════════════
// #RRGGBB → ASS &HAABBGGRR (BGR, AA=00 opaco)
function hexToAss(hex, alpha = '00') {
  const h = hex.replace('#', '');
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}
function assTime(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${h}:${p(m)}:${p(sec)}.${p(cs)}`;
}

// Gera string .ass com a camada de texto do vídeo: legenda estática + hook
// visual + bloco de CTA. Resolução do ASS = dimensões reais do vídeo
// (cfg.videoW/H) p/ não distorcer. Default vertical 1080x1920 (Reels/Stories).
//
// Posicionamento tem dois modos:
//   • cfg.safeZone ligado  → tudo ancorado na ZONA SEGURA da plataforma
//     (resolveSafeZone): legenda na base da caixa segura, hook acima dela,
//     CTA + seta no lugar da legenda nos últimos segundos.
//   • desligado → layout legado (margens fixas em % da altura).
//
// cfg.cta = { enabled, text, durationS, arrow } desenha a "ameaça tripla" no
// final: texto urgente + seta animada apontando para onde nasce o botão de CTA
// (o 3º sinal — o reenquadramento seco — é feito no FFmpeg, fora daqui).
function buildAss(blocks, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const W = c.videoW || 1080;
  const H = c.videoH || 1920;
  const vertical = H >= W;

  const captionColor = hexToAss(c.captionColor || c.karaokeColor);
  const hookColor = hexToAss(c.visualHookColor || '#FFFFFF');
  const ctaColor = hexToAss(c.ctaColor || '#FFFFFF');

  const fontSize = Math.round(H * (vertical ? 0.034 : 0.05));  // menor p/ não estourar a tela
  const hookFontSize = Math.round(H * (vertical ? 0.038 : 0.055));
  const ctaFontSize = Math.round(H * (vertical ? 0.040 : 0.055));

  // ── Posicionamento ────────────────────────────────────────────────────────
  const safe = c.safeZone
    ? resolveSafeZone(W, H, typeof c.safeZone === 'string' ? c.safeZone : (vertical ? 'reels' : 'feed'))
    : null;

  const marginLR = safe ? safe.side : Math.round(W * 0.10);    // bloco central estreito
  const marginV  = safe ? safe.bottom : Math.round(H * (vertical ? 0.18 : 0.08));
  const lineH = Math.round(fontSize * 1.25);
  const hookLineH = Math.round(hookFontSize * 1.25);
  // hook sobe acima da legenda (2 linhas + respiro) sem invadir o topo reservado
  const hookMarginV = safe
    ? Math.max(marginV + lineH, Math.min(marginV + lineH * 2 + Math.round(H * 0.02), H - safe.top - hookLineH * 3))
    : Math.round(H * (vertical ? 0.29 : 0.19));

  const outline  = Math.max(2, Math.round(fontSize * 0.12));
  const hookOutline = Math.max(2, Math.round(hookFontSize * 0.14));
  const ctaOutline = Math.max(3, Math.round(ctaFontSize * 0.16));

  // orçamento de caracteres por linha, escalado pelo corpo de cada estilo
  // (hook e CTA usam fonte maior que a legenda → cabem menos caracteres).
  const maxChars = c.maxCharsPerLine || DEFAULTS.maxCharsPerLine;
  const charsFor = size => Math.max(12, Math.round(maxChars * fontSize / size));

  // ── Janela de CTA ("ameaça tripla") ───────────────────────────────────────
  const lastEnd = (blocks || []).reduce((max, b) => Math.max(max, Number(b.end) || 0), 0);
  const totalDur = Number(c.videoDurationS) > 0 ? Number(c.videoDurationS) : lastEnd;
  const ctaCfg = c.cta && c.cta.enabled && String(c.cta.text || '').trim() && totalDur > 1.5
    ? {
        text: String(c.cta.text).trim(),
        durationS: Math.min(6, Math.max(2, Number(c.cta.durationS) || 3)),
        arrow: c.cta.arrow !== false,
      }
    : null;
  const ctaStart = ctaCfg ? Math.max(0, totalDur - ctaCfg.durationS) : null;

  // Seta: banda logo acima da linha da zona segura. A batida move a seta p/
  // BAIXO, então a amplitude entra na conta — senão o pulo cruzaria a linha e
  // metade da seta apareceria por trás da UI do Reels.
  const arrowH = Math.round(H * 0.05);
  const arrowBounce = Math.max(4, Math.round(arrowH * 0.22));
  const arrowBand = arrowH + arrowBounce;
  const arrowCy = H - marginV - arrowBounce - Math.round(arrowH / 2);
  const ctaMarginV = ctaCfg && ctaCfg.arrow ? marginV + arrowBand + Math.round(H * 0.012) : marginV;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${c.fontName},${fontSize},${captionColor},${captionColor},&H90000000,&H00000000,1,0,0,0,100,100,0,0,1,${outline},0,2,${marginLR},${marginLR},${marginV},1
Style: Hook,${c.fontName},${hookFontSize},${hookColor},${hookColor},&H90000000,&H00000000,1,0,0,0,100,100,0,0,1,${hookOutline},0,2,${marginLR},${marginLR},${hookMarginV},1
Style: Cta,${c.fontName},${ctaFontSize},${ctaColor},${ctaColor},&H90000000,&H00000000,1,0,0,0,100,100,0,0,1,${ctaOutline},0,2,${marginLR},${marginLR},${ctaMarginV},1
Style: CtaArrow,${c.fontName},${ctaFontSize},${captionColor},${captionColor},&H90000000,&H00000000,1,0,0,0,100,100,0,0,1,${ctaOutline},0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const escape = t => String(t).replace(/[{}]/g, '').replace(/\n/g, '\\N');

  const lines = [];

  // ── Hook visual (abertura) ────────────────────────────────────────────────
  const hookText = String(c.visualHook || '').trim();
  const hookRef = totalDur || lastEnd;
  if (hookText && hookRef > 0) {
    const hookEnd = Math.min(hookRef, Math.min(7, Math.max(3, Number(c.visualHookDurationS) || 5)));
    // respeita as quebras do usuário; sem elas, quebra sozinho na largura segura
    const hookBody = hookText.includes('\n')
      ? escape(hookText)
      : escape(wrapLines(hookText, charsFor(hookFontSize), 3).join('\n'));
    lines.push(`Dialogue: 1,${assTime(0)},${assTime(hookEnd)},Hook,,0,0,0,,${hookBody}`);
  }

  // ── Legenda ───────────────────────────────────────────────────────────────
  // Na janela de CTA a legenda sai de cena: o overlay de CTA ocupa o lugar dela
  // e duas camadas de texto empilhadas competiriam entre si.
  let visible = blocks || [];
  if (ctaCfg) {
    visible = [];
    for (const b of (blocks || [])) {
      if (b.start >= ctaStart - 0.05) continue;
      visible.push(b.end > ctaStart ? { ...b, end: ctaStart } : b);
    }
  }

  lines.push(...visible.map(b => {
    // guarda final: nenhuma linha começa com pontuação
    const ls = (b.lines || [b.text]).map(l => stripLeadingPunct(l));
    const body = escape(ls.join('\\N'));
    return `Dialogue: 0,${assTime(b.start)},${assTime(b.end)},Default,,0,0,0,,${body}`;
  }));

  // ── CTA "ameaça tripla" ───────────────────────────────────────────────────
  if (ctaCfg) {
    const ctaBody = escape(wrapLines(ctaCfg.text, charsFor(ctaFontSize), 3).join('\n'));
    // pop-in curto: entra crescendo, chama atenção sem piscar
    lines.push(`Dialogue: 2,${assTime(ctaStart)},${assTime(totalDur)},Cta,,0,0,0,,{\\fad(120,0)\\fscx104\\fscy104\\t(0,220,\\fscx100\\fscy100)}${ctaBody}`);
    if (ctaCfg.arrow) lines.push(...buildCtaArrowLines(ctaStart, totalDur, { W, cy: arrowCy, size: arrowH, bounce: arrowBounce }));
  }

  return header + '\n' + lines.join('\n') + '\n';
}

// Seta animada apontando para baixo (onde nasce o botão de CTA do anúncio).
// Desenhada em vetor ASS (\p1) em vez de glifo: independe da fonte instalada.
// A "batida" vem de meios-ciclos de \move — \t não faz loop em ASS.
function buildCtaArrowLines(start, end, { W, cy, size, bounce, cycleS = 0.6 }) {
  const a = Math.round(size / 2);
  const sh = Math.max(4, Math.round(size * 0.13));   // meia-largura da haste
  const hw = Math.max(8, Math.round(size * 0.34));   // meia-largura da ponta
  const hy = Math.round(size * 0.02);
  const draw = `m ${-sh} ${-a} l ${sh} ${-a} l ${sh} ${hy} l ${hw} ${hy} l 0 ${a} l ${-hw} ${hy} l ${-sh} ${hy}`;
  const cx = Math.round(W / 2);
  const bord = Math.max(3, Math.round(size * 0.07));   // borda do texto de CTA é grossa demais p/ vetor
  const amp = bounce || Math.max(4, Math.round(size * 0.22));
  const half = cycleS / 2;
  const out = [];
  let t = start, down = true;
  while (t < end - 0.02) {
    const seg = Math.min(half, end - t);
    const ms = Math.round(seg * 1000);
    const y1 = down ? cy : cy + amp;
    const y2 = down ? cy + amp : cy;
    out.push(`Dialogue: 2,${assTime(t)},${assTime(t + seg)},CtaArrow,,0,0,0,,{\\an5\\bord${bord}\\move(${cx},${y1},${cx},${y2},0,${ms})\\p1}${draw}{\\p0}`);
    t += seg; down = !down;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// B-1 — Jump cut: detecção (dual signal: Whisper word-gaps ∩ silencedetect)
// ════════════════════════════════════════════════════════════════════════════
// silenceDetectIntervals: [{start,end}] vindos do FFmpeg silencedetect (acústico)
// words: [{text,start,end}] do Whisper (pode ser vazio → cai p/ silencedetect-only)
// Retorna { cuts:[{start,end,reason}], keep:[{start,end}], stats }
function detectJumpCuts(duration, silenceIntervals, words, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const minGap = AGGRESSION_GAP_S[c.aggressiveness] ?? AGGRESSION_GAP_S.medio;
  const hasWords = Array.isArray(words) && words.length > 0;

  // Lacunas de fala a partir das palavras (word_level preciso)
  const wordGaps = [];
  if (hasWords) {
    const sorted = [...words].sort((a, b) => a.start - b.start);
    if (sorted[0].start > minGap) wordGaps.push({ start: 0, end: sorted[0].start });
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].start - sorted[i - 1].end;
      if (gap >= minGap) wordGaps.push({ start: sorted[i - 1].end, end: sorted[i].start });
    }
    const last = sorted[sorted.length - 1];
    if (duration - last.end > minGap) wordGaps.push({ start: last.end, end: duration });
  }

  // Interseção de dois intervalos
  const overlap = (a, b) => {
    const s = Math.max(a.start, b.start), e = Math.min(a.end, b.end);
    return e > s ? { start: s, end: e } : null;
  };

  // Decide cortes: onde AMBOS concordam (acústico ∩ word-gap). Sem words →
  // usa só silencedetect (documentado como menos preciso).
  let rawCuts = [];
  if (hasWords) {
    for (const si of silenceIntervals) {
      for (const wg of wordGaps) {
        const ov = overlap(si, wg);
        if (ov && (ov.end - ov.start) >= minGap) rawCuts.push({ ...ov, reason: 'silencio+lacuna' });
      }
    }
  } else {
    rawCuts = silenceIntervals.filter(s => (s.end - s.start) >= minGap).map(s => ({ ...s, reason: 'silencedetect' }));
  }

  // Hesitações isoladas (palavra curta de preenchimento cercada por gaps) →
  // marca como corte opcional/agressivo
  if (hasWords && c.aggressiveness === 'agressivo') {
    for (const w of words) {
      const t = w.text.toLowerCase().replace(/[.,;:!?…]/g, '');
      if (HESITATIONS.has(t) && (w.end - w.start) < 0.6) rawCuts.push({ start: w.start, end: w.end, reason: 'hesitacao' });
    }
  }

  // Aplica padding de segurança (encolhe o corte p/ não comer sílaba) e
  // preserva pausa retórica: a 1ª pausa logo após pontuação forte, se 0.5–0.9s,
  // NÃO é cortada (respiro proposital).
  const strongPunctEnds = new Set();
  if (hasWords) {
    for (const w of words) if (/[.!?]$/.test(w.text)) strongPunctEnds.add(Math.round(w.end * 100));
  }
  const cuts = [];
  for (const cut of rawCuts) {
    const s = cut.start + c.padBeforeS;
    const e = cut.end - c.padAfterS;
    const len = e - s;
    if (len <= 0.05) continue;
    // pausa retórica: começa logo após fim de palavra com pontuação forte?
    const afterStrong = strongPunctEnds.has(Math.round(cut.start * 100));
    if (afterStrong && (cut.end - cut.start) >= 0.5 && (cut.end - cut.start) <= 0.9 && cut.reason !== 'hesitacao') {
      continue; // preserva respiro retórico
    }
    cuts.push({ start: +s.toFixed(3), end: +e.toFixed(3), reason: cut.reason });
  }

  // Mescla cortes sobrepostos/adjacentes
  cuts.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const cut of cuts) {
    const last = merged[merged.length - 1];
    if (last && cut.start <= last.end + 0.02) { last.end = Math.max(last.end, cut.end); }
    else merged.push({ ...cut });
  }

  // Segmentos a MANTER (complemento dos cortes)
  const keep = [];
  let cursor = 0;
  for (const cut of merged) {
    if (cut.start > cursor + 0.05) keep.push({ start: +cursor.toFixed(3), end: +cut.start.toFixed(3) });
    cursor = cut.end;
  }
  if (cursor < duration - 0.05) keep.push({ start: +cursor.toFixed(3), end: +duration.toFixed(3) });

  const removed = merged.reduce((a, x) => a + (x.end - x.start), 0);
  return {
    cuts: merged,
    keep,
    stats: {
      mode: hasWords ? 'preciso (word-gap ∩ silencedetect)' : 'aproximado (silencedetect)',
      duration_original: +duration.toFixed(2),
      duration_estimada: +(duration - removed).toFixed(2),
      removido_s: +removed.toFixed(2),
      n_cortes: merged.length,
    },
  };
}

// Constrói o complexFilter do FFmpeg para concatenar os segmentos KEEP.
// Áudio: micro fade-in/out DENTRO de cada segmento + concat (evita clique/estalo
// sem alterar a duração). NÃO usar acrossfade aqui: ele SOBREPÕE os segmentos e
// encurta o áudio ~crossfadeMs por emenda, enquanto o vídeo (concat) mantém a
// duração cheia — com dezenas de cortes o áudio dessincroniza progressivamente.
// Recodifica (corte frame-accurate). Retorna { filter, maps } ou null.
function buildKeepFilter(keep, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  if (!keep || keep.length === 0) return null;
  if (keep.length === 1) {
    // 1 segmento → trim simples, sem concat/fade
    const k = keep[0];
    return {
      filter: `[0:v]trim=${k.start}:${k.end},setpts=PTS-STARTPTS[vout];[0:a]atrim=${k.start}:${k.end},asetpts=PTS-STARTPTS[aout]`,
      maps: ['[vout]', '[aout]'],
    };
  }
  const xfade = Math.max(0.003, c.crossfadeMs / 1000);
  const v = [], a = [];
  keep.forEach((k, i) => {
    const len = k.end - k.start;
    const fade = Math.min(xfade, Math.max(0.003, len / 4));
    const fd = fade.toFixed(3);
    const foSt = Math.max(0, len - fade).toFixed(3);
    v.push(`[0:v]trim=${k.start}:${k.end},setpts=PTS-STARTPTS[v${i}]`);
    a.push(`[0:a]atrim=${k.start}:${k.end},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fd},afade=t=out:st=${foSt}:d=${fd}[a${i}]`);
  });
  // vídeo: concat direto (corte seco no vídeo é ok; o estalo é problema de áudio)
  const vConcatInputs = keep.map((_, i) => `[v${i}]`).join('');
  const vConcat = `${vConcatInputs}concat=n=${keep.length}:v=1:a=0[vout]`;
  // áudio: concat direto (mesma duração do vídeo; fades já suavizaram as bordas)
  const aConcatInputs = keep.map((_, i) => `[a${i}]`).join('');
  const aConcat = `${aConcatInputs}concat=n=${keep.length}:v=0:a=1[aout]`;
  const filter = [...v, ...a, vConcat, aConcat].join(';');
  return { filter, maps: ['[vout]', '[aout]'] };
}

// ════════════════════════════════════════════════════════════════════════════
// B-2 — Ritmo visual / pattern interrupt
// ════════════════════════════════════════════════════════════════════════════
// events: lista de timestamps (s) de mudanças visuais (cortes, zooms, overlays).
// Retorna análise + sugestões de zoom para trechos parados.
function analyzeVisualRhythm(duration, events, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const pts = [...new Set([0, ...(events || []).filter(t => t > 0 && t < duration), duration])].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < pts.length; i++) {
    const len = pts[i] - pts[i - 1];
    let flag;
    if (len < c.visualIdealLowS) flag = '⚡rapido';
    else if (len <= c.visualIdealHighS) flag = '🟢ideal';
    else if (len <= c.visualSlowS) flag = '🟡lento';
    else flag = '🔴parado';
    gaps.push({ start: +pts[i - 1].toFixed(2), end: +pts[i].toFixed(2), dur: +len.toFixed(2), flag });
  }
  const avg = gaps.length ? gaps.reduce((a, g) => a + g.dur, 0) / gaps.length : 0;
  const parados = gaps.filter(g => g.dur > c.visualSlowS);
  // Sugestão de zoom: trecho parado → zoom suave centralizado 1.0→1.08 em 0.5s
  const zoomSuggestions = parados.map(g => ({
    start: g.start, end: g.end,
    zoom: { from: 1.0, to: 1.08, rampS: 0.5, center: 'face_center_assumido' },
  }));
  return {
    ritmo_medio_s: +avg.toFixed(2),
    n_eventos: pts.length - 2,
    gaps,
    trechos_parados: parados,
    zoom_suggestions: zoomSuggestions,
  };
}

// Filtro de zoom suave centralizado (zoompan) para um trecho [start,end].
// (legado — mantido p/ compat). Use buildRetentionZoom p/ múltiplas janelas.
function buildZoomFilter(start, end, fps = 30, from = 1.0, to = 1.08, rampS = 0.5) {
  const rampFrames = Math.max(1, Math.round(rampS * fps));
  const z = `min(${from}+(${(to - from).toFixed(4)})*on/${rampFrames}\\,${to})`;
  return `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:fps=${fps}`;
}

// Zoom de retenção time-aware (crop+scale) aplicado SÓ nas janelas paradas.
// Ponto focal heurístico (sem ML): centro-X, focalY do topo (0.38 vertical typ.
// p/ talking head). z(t) sobe de 1.0→`to` em rampS dentro de cada janela e
// volta a 1.0 fora. Wrapped pelo chamador; opt-in.
function buildRetentionZoom(windows, { w, h, to = 1.08, rampS = 0.5, focalY = 0.38 } = {}) {
  const wins = (windows || []).filter(g => g && g.end > g.start);
  if (!wins.length || !w || !h) return null;
  // expressão de fator de zoom: max das rampas de cada janela, default 1.0
  let z = '1.0';
  for (const g of wins) {
    const s = g.start.toFixed(3), e = g.end.toFixed(3);
    const ramp = `min(1.0+${(to - 1).toFixed(4)}*(t-${s})/${rampS}\\,${to})`;
    const inWin = `if(between(t\\,${s}\\,${e})\\,${ramp}\\,1.0)`;
    z = `max(${inWin}\\,${z})`;
  }
  // crop centrado em X e em focalY no Y; depois reescala ao tamanho original
  const fx = '0.5';
  const fy = focalY.toFixed(3);
  const cw = `iw/(${z})`;
  const ch = `ih/(${z})`;
  const cx = `(iw-${cw})*${fx}`;
  const cy = `(ih-${ch})*${fy}`;
  return `crop=w='${cw}':h='${ch}':x='${cx}':y='${cy}',scale=${w}:${h}`;
}

// Re-mapeia tempos das palavras para o timeline APÓS o corte (keep segments).
// Palavras dentro de trechos removidos são descartadas; as que sobram têm o
// tempo deslocado pela soma das durações removidas antes delas. Determinístico.
function remapWordsThroughKeep(words, keep) {
  if (!Array.isArray(keep) || !keep.length) return words || [];
  const out = [];
  for (const w of (words || [])) {
    // acha o segmento keep que contém o início da palavra
    let newStart = null, removedBefore = 0;
    for (const k of keep) {
      if (w.start >= k.start && w.start < k.end) {
        // soma do que foi removido antes deste keep
        newStart = w.start - removedBeforeKeep(keep, k);
        break;
      }
    }
    if (newStart === null) {
      // palavra caiu num trecho cortado; se era fim de frase, a fronteira passa
      // p/ a última palavra mantida (senão duas frases se fundem numa legenda)
      if (w.sentenceEnd && out.length) out[out.length - 1].sentenceEnd = true;
      continue;
    }
    const dur = Math.max(0.05, w.end - w.start);
    out.push({ text: w.text, start: +newStart.toFixed(3), end: +(newStart + dur).toFixed(3), sentenceEnd: !!w.sentenceEnd });
  }
  return out;
}
function removedBeforeKeep(keep, target) {
  // tempo total entre o início (0) e o início do keep `target` que NÃO é keep
  let removed = 0, cursor = 0;
  for (const k of keep) {
    if (k === target) { removed += Math.max(0, k.start - cursor); break; }
    removed += Math.max(0, k.start - cursor);
    cursor = k.end;
  }
  return removed;
}

// SRT a partir dos blocos JÁ otimizados (mesma limpeza/encaixe do ASS).
// Usado como fallback quando o burn de ASS falha — mantém texto limpo.
function srtTime(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(sec)},${p(ms, 3)}`;
}
function buildSrtFromBlocks(blocks) {
  const out = (blocks || []).map((b, i) => {
    const ls = (b.lines || [b.text]).map(l => stripLeadingPunct(l));
    return `${i + 1}\n${srtTime(b.start)} --> ${srtTime(b.end)}\n${ls.join('\n')}`;
  });
  return out.length ? out.join('\n\n') + '\n' : '';
}

// ── EDL (lista de edição não-destrutiva) ─────────────────────────────────────
function writeEdl(sessionDir, edl) {
  try {
    const p = path.join(sessionDir, 'edl.json');
    fs.writeFileSync(p, JSON.stringify(edl, null, 2));
    return p;
  } catch { return null; }
}

module.exports = {
  DEFAULTS,
  AGGRESSION_GAP_S,
  SAFE_ZONES,
  HOOK_MAX_CHARS,
  resolveSafeZone,
  detectOfferMoment,
  buildHardCutFilter,
  detectTimestampGranularity,
  cleanWordToken,
  flattenWords,
  markSentenceEnds,
  approxWordsFromSegments,
  resegmentCaptions,
  wrapLines,
  reviewCaptionsPT,
  REVIEW_MODEL,
  validateCaptions,
  autoFixCaptions,
  buildAss,
  buildCtaArrowLines,
  hexToAss,
  detectJumpCuts,
  buildKeepFilter,
  analyzeVisualRhythm,
  buildZoomFilter,
  buildRetentionZoom,
  remapWordsThroughKeep,
  buildSrtFromBlocks,
  writeEdl,
};

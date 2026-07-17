const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
// archiver v8 mudou a API: exporta classes nomeadas em vez da função-fábrica
const { ZipArchive } = require('archiver');
const { downloadFolderImages } = require('./driveDownloader');

const TMP_DIR = path.join(__dirname, '../../tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Paleta e tipografia TableClinic. Marca = verde/bege/terracota; demais cores
// liberadas para personalização por slide (o usuário pode pedir qualquer uma,
// ou um hex). Sinônimos PT mapeados.
// Paleta restrita à ID visual: VERDE, TERRACOTA, CREME + variações tonais
// (claro/escuro) de cada uma. Sem cores fora da marca.
const THEME = {
  // Verde
  verde:           '#3D4A35',
  'verde-escuro':  '#2A3325',
  'verde-claro':   '#5A6B4D',
  'verde-suave':   '#7C8A6E',
  // Terracota
  terracota:        '#B97040',
  terracotta:       '#B97040',
  'terracota-escuro':'#9A5A30',
  'terracota-claro': '#CE8C5E',
  'terracota-suave': '#E0AE85',
  // Creme / bege
  creme:        '#F8F4EE',
  bege:         '#F8F4EE',
  'creme-escuro':'#EDE5D8',
  'bege-escuro': '#E8E0D4',
  areia:        '#E3D7C3',
  marfim:       '#FBF8F2',
};

// Cor de texto que contrasta com o fundo (luminância). Garante legibilidade em
// QUALQUER cor de fundo (clara → texto verde escuro; escura → bege).
function hexLum(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return 1;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastText(bg) {
  return hexLum(bg) > 0.55 ? '#3D4A35' : '#F8F4EE';
}
function contrastAccent(bg) {
  return hexLum(bg) > 0.55 ? '#B97040' : '#F8F4EE';
}
function resolveColor(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (THEME[t]) return THEME[t];
  if (/^#[0-9a-f]{3,6}$/i.test(v.trim())) return v.trim();
  return null;
}

// Cabeçalho de slide tolerante: aceita markdown (#, *, >, -), rótulos variados e
// qualificadores como "(HOOK)". Ex.: "SLIDE 1", "**SLIDE 2:**", "## Slide 3 (CTA)",
// "CARD 1 -", "Página 4:", "VÍDEO DE CAPA".
const SLIDE_HEADER_RE = /^[#>*\-\s]*\**\s*(SLIDE\s*\d+|SLIDE\s+FINAL|CARD\s*\d+|P[ÁA]GINA\s*\d+|TELA\s*\d+|V[ÍI]?DEO\s+DE\s+CAPA)\b(.*)$/i;

// Formato numerado por linha: "01·Cover:", "02·Setup:", "1) ...", "1. ...", "3 - ...".
// Captura o número e o resto. Usado só quando NÃO há cabeçalhos SLIDE/CARD/etc.,
// para não quebrar listas numeradas dentro do conteúdo de um slide.
const NUM_HEADER_RE = /^[#>*\s]*\**\s*(\d{1,2})\s*[·.):–—-]\s*(\S.*)$/;

function blockToSlide(chunk, i, total) {
  const isFirst = i === 0;
  const isLast = i === total - 1;
  return {
    label: '', // sem rótulo automático — título só quando o usuário fornece
    text: chunk.trim(),
    bg: isFirst || isLast ? THEME.verde : THEME.bege,
    textColor: isFirst || isLast ? THEME.bege : THEME.verde,
    fontSize: isFirst ? 52 : 40,
    isHook: isFirst,
    isCTA: isLast,
  };
}

// Parseia o texto (do Claude ou digitado) em slides estruturados
function parseSlides(rawContent) {
  let content = String(rawContent || '').replace(/\r/g, '');

  // 1. Remove a seção final de LEGENDA/CAPTION — ela não é um slide
  const legenda = content.match(/^[\s>*#-]*\**\s*(LEGENDA|CAPTION|DESCRI[ÇC][ÃA]O)\b/im);
  if (legenda && legenda.index > 0) content = content.slice(0, legenda.index);

  // 2. Remove divisores horizontais (---, ***, ___) — viram quebra de parágrafo
  content = content.replace(/^[ \t]*([-*_]){3,}[ \t]*$/gm, '');

  const lines = content.split('\n');
  // Se há cabeçalhos SLIDE/CARD/etc., só eles delimitam (números viram conteúdo).
  // Sem eles, ativamos o formato numerado ("01·Cover:") como delimitador.
  const hasSlideHeaders = lines.some(l => SLIDE_HEADER_RE.test(l.trim()));
  const slides = [];
  let current = null;
  let headerCount = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) { if (current && current.text) current.text += '\n'; continue; }

    const h = trimmed.match(SLIDE_HEADER_RE);
    const nh = (!h && !hasSlideHeaders) ? trimmed.match(NUM_HEADER_RE) : null;
    if (h) {
      headerCount++;
      if (current) slides.push(current);
      const label = h[1].toUpperCase().replace(/\s+/g, ' ');
      // Texto na mesma linha do cabeçalho: remove bold, qualificador "(HOOK)" e separador
      let inline = h[2].replace(/\*+/g, '').trim()
        .replace(/^\([^)]*\)\s*/, '')
        .replace(/^[:：•\-–—]\s*/, '')
        .trim();
      current = {
        label,
        text: inline,
        bg: THEME.verde,
        textColor: THEME.bege,
        fontSize: 48,
        isHook: /(SLIDE\s*1\b|CAPA)/.test(label),
        isCTA: /FINAL/.test(label),
      };
      continue;
    }

    // Formato numerado: cada linha "NN<sep> Rótulo: texto" vira um slide.
    if (nh) {
      headerCount++;
      if (current) slides.push(current);
      const n = parseInt(nh[1], 10);
      const rest = nh[2].replace(/\*+/g, '').trim();
      // Rótulo curto antes do ":" (Cover, Setup, Sinal 1, CTA…) — senão "SLIDE N"
      const colonIdx = rest.indexOf(':');
      const pre = colonIdx > 0 ? rest.slice(0, colonIdx).trim() : '';
      let label, body;
      if (pre && pre.length <= 20 && /^[\p{L}\d][\p{L}\d\s]*$/u.test(pre)) {
        label = pre.toUpperCase().replace(/\s+/g, ' ');
        body = rest.slice(colonIdx + 1).trim();
      } else {
        label = `SLIDE ${n}`;
        body = rest;
      }
      // Prefere o texto entre aspas (o que aparece no slide) e descarta direções
      // fora das aspas, ex.: '— tipografia grande, sem foto de comida'.
      const quoted = [...body.matchAll(/[“"]([^”"]+)[”"]/g)].map(m => m[1].trim()).filter(Boolean);
      const text = quoted.length ? quoted.join('\n') : body;
      const isHook = n === 1 || /\b(COVER|CAPA|HOOK)\b/.test(label);
      const isCTA = /\b(CTA|FINAL)\b/.test(label);
      current = {
        label,
        text,
        bg: (isHook || isCTA) ? THEME.verde : THEME.bege,
        textColor: (isHook || isCTA) ? THEME.bege : THEME.verde,
        fontSize: isHook ? 52 : 40,
        isHook,
        isCTA,
      };
      continue;
    }

    if (!current) continue;

    // Cor de fundo sugerida
    const bgMatch = trimmed.match(/cor\s+de\s+fundo[:\s]*([#\w]+)/i);
    if (bgMatch) {
      const raw = bgMatch[1].trim();
      const safeColor = /^#[0-9a-fA-F]{3,6}$/.test(raw) ? raw : (THEME[raw.toLowerCase()] || null);
      if (safeColor) {
        current.bg = safeColor;
        current.textColor = current.bg === THEME.bege ? THEME.verde : THEME.bege;
      }
      continue;
    }

    // Tamanho de fonte sugerido
    const sizeMatch = trimmed.match(/tamanho[:\s]*(\d+)/i);
    if (sizeMatch) { current.fontSize = parseInt(sizeMatch[1], 10); continue; }

    // Acumula texto (limpa marcadores de lista/markdown e linhas de especificação visual)
    const cleaned = trimmed.replace(/^[#>\-*]+\s*/, '').replace(/\*\*/g, '').trim();
    if (cleaned && !/^(especificaç|fonte\s*:|visual\s*:|fundo\s*:)/i.test(cleaned)) {
      current.text += (current.text ? '\n' : '') + cleaned;
    }
  }

  if (current) slides.push(current);

  let result = slides.filter(s => s.text && s.text.trim());

  // 3. Fallback: nenhum cabeçalho reconhecido → divide por parágrafos (linhas em branco)
  if (headerCount === 0) {
    const blocks = content
      .split(/\n\s*\n/)
      .map(b => b.replace(/^[#>\-*\s]+/, '').replace(/\*\*/g, '').trim())
      .filter(Boolean);
    if (blocks.length > 1) {
      result = blocks.map((chunk, i) => blockToSlide(chunk, i, blocks.length));
    } else if (blocks.length === 1) {
      result = [blockToSlide(blocks[0], 0, 1)];
    }
  }

  return result;
}

// ── Tamanho de fonte automático ──────────────────────────────────────────────
// Em vez de 52/40 fixos: o tamanho acompanha o volume de texto, então um slide
// só-headline sai grande e um slide denso não estoura a moldura.
function fitHeadline(text) {
  const len = String(text || '').length;
  if (len <= 30) return 84;
  if (len <= 60) return 72;
  if (len <= 100) return 60;
  return 50;
}
function fitBody(text, hasHeadline) {
  const len = String(text || '').length;
  const base = len <= 90 ? 54 : len <= 180 ? 46 : len <= 300 ? 40 : len <= 450 ? 34 : 30;
  // com headline em cima, o corpo desce um degrau p/ hierarquia clara
  return hasHeadline ? Math.max(28, base - 8) : base;
}

// Converte o conteúdo estruturado (JSON da IA) em slides de render.
// Cada slide é uma COMPOSIÇÃO de blocos opcionais — kicker (rótulo pequeno),
// headline (serifada grande), text (corpo), list (itens), quote (frase em
// destaque), signature — em vez de um texto único num template fixo.
// Retorna null se não for JSON estruturado — aí o caller cai no parseSlides.
function slidesFromStructured(rawContent) {
  let data;
  try { data = JSON.parse(String(rawContent || '').trim()); } catch { return null; }
  if (!data || !Array.isArray(data.slides) || data.slides.length === 0) return null;

  const n = data.slides.length;
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : '');
  return data.slides.map((s, i) => {
    const role = ['hook', 'content', 'cta'].includes(s.role)
      ? s.role : (i === 0 ? 'hook' : i === n - 1 ? 'cta' : 'content');
    const isHook = role === 'hook';
    const isCTA = role === 'cta';
    const bg = resolveColor(s.bg) || (isCTA ? THEME.terracota : isHook ? THEME.verde : THEME.bege);
    const textColor = resolveColor(s.textColor || s.text_color || s.cor_texto) || contrastText(bg);

    // foto: legado `true` = fundo suave (18%); "forte" = foto cheia com overlay
    const photoMode = s.photo === 'forte' ? 'forte'
      : (s.photo === true || s.photo === 'fundo') ? 'fundo' : null;

    const headline = str(s.headline);
    const list = Array.isArray(s.list) ? s.list.map(x => String(x).trim()).filter(Boolean) : null;
    return {
      // title legado vira kicker (rótulo pequeno acima do conteúdo)
      kicker: str(s.kicker) || str(s.title),
      headline,
      text: String(s.text || '').trim(),
      list: list && list.length ? list : null,
      quote: s.quote === true,
      signature: str(s.signature),
      align: ['center', 'left'].includes(s.align) ? s.align : (isHook ? 'center' : 'left'),
      bg,
      textColor,
      accent: resolveColor(s.accent || s.cor_destaque) || contrastAccent(bg),
      fontSize: null, // automático por volume de texto (fitHeadline/fitBody)
      isHook,
      isCTA,
      photoMode,
      wantPhoto: photoMode !== null,
    };
  }).filter(s => s.text || s.headline || (s.list && s.list.length));
}

function buildSlideHtml(slide, index, total, photoPath) {
  const photoB64 = photoPath && fs.existsSync(photoPath)
    ? `data:image/jpeg;base64,${fs.readFileSync(photoPath).toString('base64')}`
    : null;
  const accent = slide.accent || contrastAccent(slide.bg);
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Retrocompat: slide legado (parseSlides) traz `label`+`fontSize`, sem blocos.
  // Mapeia label→kicker e respeita o fontSize antigo como corpo.
  const kicker = slide.kicker || slide.label || '';
  const headline = slide.headline || '';
  const body = String(slide.text || '').trim();
  const list = Array.isArray(slide.list) && slide.list.length ? slide.list : null;
  const isQuote = slide.quote === true;
  const signature = slide.signature || '';
  const align = slide.align || (slide.isHook ? 'center' : 'left');

  // Tamanhos: automáticos por volume, ou o fontSize legado quando presente.
  const legacy = typeof slide.fontSize === 'number' && slide.fontSize > 0;
  const headSize = headline ? fitHeadline(headline) : 0;
  const bodySize = legacy ? Math.min(slide.fontSize, 60) : fitBody(body, !!headline);
  const quoteSize = fitHeadline(body) - 8;
  const kickerSize = 26;
  const sigSize = 30;

  // Foto: 'forte' = cheia com scrim p/ o texto ler; 'fundo' = marca d'água 18%.
  // Sem modo explícito mas com foto passada (caminho legado) → 'fundo'.
  const photoMode = photoB64 ? (slide.photoMode === 'forte' ? 'forte' : 'fundo') : null;
  const photoForte = photoMode === 'forte';
  const photoFundo = photoMode === 'fundo';
  // Em foto forte, o texto assenta numa faixa escura translúcida p/ contraste.
  const onScrim = photoForte;
  const bodyColor = onScrim ? '#F8F4EE' : slide.textColor;
  const scrimAccent = onScrim ? '#F8F4EE' : accent;

  const blocks = [];
  blocks.push(`<div class="accent-bar"></div>`);
  if (kicker) blocks.push(`<div class="kicker">${esc(kicker)}</div>`);
  if (headline) blocks.push(`<div class="headline">${esc(headline)}</div>`);
  if (isQuote && body) {
    blocks.push(`<div class="quote">${esc(body).split('\n').join('<br>')}</div>`);
  } else if (body) {
    const paras = body.split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => `<p>${esc(l)}</p>`).join('');
    blocks.push(`<div class="body">${paras}</div>`);
  }
  if (list) {
    const items = list.map(it => `<li>${esc(it)}</li>`).join('');
    blocks.push(`<ul class="list">${items}</ul>`);
  }
  if (signature) blocks.push(`<div class="signature">${esc(signature)}</div>`);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400;1,600&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1080px; height: 1080px; overflow: hidden; }
  body {
    background: ${slide.bg};
    color: ${slide.textColor};
    font-family: 'Jost', sans-serif;
    display: flex; flex-direction: column;
    justify-content: center; align-items: ${align === 'center' ? 'center' : 'flex-start'};
    padding: 96px 88px; position: relative;
  }
  ${photoFundo ? `.photo-bg { position:absolute; inset:0; background:url('${photoB64}') center/cover no-repeat; opacity:0.18; }` : ''}
  ${photoForte ? `.photo-bg { position:absolute; inset:0; background:url('${photoB64}') center/cover no-repeat; }
  .scrim { position:absolute; inset:0; background:linear-gradient(180deg, rgba(29,34,24,0.30) 0%, rgba(29,34,24,0.68) 100%); }` : ''}
  .corner-mark { position:absolute; top:44px; left:52px; font-family:'Cormorant Garamond',serif; font-size:22px; letter-spacing:1px; opacity:0.55; color:${onScrim ? '#F8F4EE' : slide.textColor}; }
  .slide-num { position:absolute; bottom:44px; right:52px; font-size:15px; letter-spacing:2px; font-weight:300; opacity:0.5; color:${onScrim ? '#F8F4EE' : slide.textColor}; }
  .content {
    position: relative; z-index: 2;
    text-align: ${align}; max-width: 900px; width: 100%;
    display: flex; flex-direction: column; gap: 26px;
    align-items: ${align === 'center' ? 'center' : 'flex-start'};
  }
  .accent-bar { width: 56px; height: 3px; background: ${scrimAccent}; }
  .kicker {
    font-family:'Jost',sans-serif; font-weight:600; font-size:${kickerSize}px;
    letter-spacing:0.22em; text-transform:uppercase; color:${scrimAccent};
  }
  .headline {
    font-family:'Cormorant Garamond',serif; font-weight:600;
    font-size:${headSize}px; line-height:1.08; letter-spacing:-0.01em;
    color:${onScrim ? '#F8F4EE' : slide.textColor}; text-wrap:balance;
  }
  .body { display:flex; flex-direction:column; gap:14px; }
  .body p {
    font-family:'Jost',sans-serif; font-weight:400;
    font-size:${bodySize}px; line-height:1.42; color:${bodyColor};
  }
  .quote {
    font-family:'Cormorant Garamond',serif; font-style:italic; font-weight:600;
    font-size:${quoteSize}px; line-height:1.2; color:${onScrim ? '#F8F4EE' : slide.textColor};
    text-wrap:balance;
  }
  .list { list-style:none; display:flex; flex-direction:column; gap:18px; width:100%; }
  .list li {
    font-family:'Jost',sans-serif; font-weight:400; font-size:${Math.max(30, bodySize - 2)}px;
    line-height:1.34; color:${bodyColor}; padding-left:40px; position:relative; text-align:left;
  }
  .list li::before {
    content:''; position:absolute; left:0; top:0.62em;
    width:18px; height:2px; background:${scrimAccent};
  }
  .signature {
    font-family:'Cormorant Garamond',serif; font-style:italic; font-size:${sigSize}px;
    opacity:0.82; color:${onScrim ? '#F8F4EE' : slide.textColor}; margin-top:8px;
  }
</style>
</head>
<body>
  ${photoFundo || photoForte ? '<div class="photo-bg"></div>' : ''}
  ${photoForte ? '<div class="scrim"></div>' : ''}
  <div class="corner-mark">Table</div>
  <div class="slide-num">${index + 1} / ${total}</div>
  <div class="content">
    ${blocks.join('\n    ')}
  </div>
</body>
</html>`;
}

async function generateCarousel(rawContent, cardId, driveFolderUrl) {
  // Conteúdo estruturado (IA) tem prioridade; texto livre/colado cai no parseSlides
  const slides = slidesFromStructured(rawContent) || parseSlides(rawContent);
  if (slides.length === 0) throw new Error('Nenhum slide detectado no conteúdo');

  const sessionDir = path.join(TMP_DIR, `carousel_${cardId}_${Date.now()}`);
  fs.mkdirSync(sessionDir);

  // Baixa fotos da pasta do Drive se fornecida
  let photos = [];
  if (driveFolderUrl) {
    try {
      photos = await downloadFolderImages(driveFolderUrl, sessionDir);
      console.log(`[carousel] ${photos.length} foto(s) baixada(s) do Drive`);
    } catch (e) {
      console.warn('[carousel] Falha ao baixar fotos do Drive:', e.message);
    }
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const imagePaths = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });

    let photoCursor = 0;
    for (let i = 0; i < slides.length; i++) {
      // Estruturado respeita o flag por slide (só usa foto onde pedido);
      // legado (wantPhoto undefined) cicla foto em todos os slides.
      const usePhoto = slides[i].wantPhoto !== false;
      const photo = (usePhoto && photos.length > 0) ? photos[photoCursor++ % photos.length] : null;
      const html = buildSlideHtml(slides[i], i, slides.length, photo);
      // fix: não usar networkidle0 — se o CDN de fontes travar, a geração inteira falha.
      // Renderiza assim que o DOM carrega e espera as fontes no máximo 3s (fallback seguro).
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.evaluate(() =>
        Promise.race([
          document.fonts.ready,
          new Promise(resolve => setTimeout(resolve, 3000)),
        ])
      );

      const imgPath = path.join(sessionDir, `slide_${String(i + 1).padStart(2, '0')}.png`);
      await page.screenshot({ path: imgPath, type: 'png', clip: { x:0, y:0, width:1080, height:1080 } });
      imagePaths.push(imgPath);
    }
  } finally {
    await browser.close();
  }

  // Compactar slides em ZIP para download
  const zipPath = path.join(sessionDir, `carrossel_${cardId}.zip`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    imagePaths.forEach(p => archive.file(p, { name: path.basename(p) }));
    archive.finalize();
  });

  return { slides: slides.length, imagePaths, zipPath, sessionDir };
}

// Limpeza de arquivos temporários com mais de 2h
function cleanTmp() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  fs.readdirSync(TMP_DIR).forEach(name => {
    const full = path.join(TMP_DIR, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
    } catch {}
  });
}

module.exports = { generateCarousel, cleanTmp, parseSlides };

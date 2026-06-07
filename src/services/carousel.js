const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
// archiver v8 mudou a API: exporta classes nomeadas em vez da função-fábrica
const { ZipArchive } = require('archiver');
const { downloadFolderImages } = require('./driveDownloader');

const TMP_DIR = path.join(__dirname, '../../tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Paleta e tipografia TableClinic
const THEME = {
  verde:     '#3D4A35',
  bege:      '#F8F4EE',
  terracota: '#B97040',
  branco:    '#FFFFFF',
};

// Cabeçalho de slide tolerante: aceita markdown (#, *, >, -), rótulos variados e
// qualificadores como "(HOOK)". Ex.: "SLIDE 1", "**SLIDE 2:**", "## Slide 3 (CTA)",
// "CARD 1 -", "Página 4:", "VÍDEO DE CAPA".
const SLIDE_HEADER_RE = /^[#>*\-\s]*\**\s*(SLIDE\s*\d+|SLIDE\s+FINAL|CARD\s*\d+|P[ÁA]GINA\s*\d+|TELA\s*\d+|V[ÍI]?DEO\s+DE\s+CAPA)\b(.*)$/i;

function blockToSlide(chunk, i, total) {
  const isFirst = i === 0;
  const isLast = i === total - 1;
  return {
    label: isFirst ? 'SLIDE 1' : isLast ? 'SLIDE FINAL' : `SLIDE ${i + 1}`,
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
  const slides = [];
  let current = null;
  let headerCount = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) { if (current && current.text) current.text += '\n'; continue; }

    const h = trimmed.match(SLIDE_HEADER_RE);
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

function buildSlideHtml(slide, index, total, photoPath) {
  const photoB64 = photoPath && fs.existsSync(photoPath)
    ? `data:image/jpeg;base64,${fs.readFileSync(photoPath).toString('base64')}`
    : null;
  const accent = slide.isCTA ? THEME.terracota : (slide.bg === THEME.bege ? THEME.verde : THEME.terracota);
  const textLines = slide.text
    .split('\n')
    .map(l => `<p>${l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1080px; height: 1080px; overflow: hidden; }
  body {
    background: ${slide.bg};
    color: ${slide.textColor};
    font-family: 'Jost', sans-serif;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    padding: 80px;
    position: relative;
  }
  ${photoB64 ? `
  .photo-bg {
    position: absolute; inset: 0;
    background: url('${photoB64}') center/cover no-repeat;
    opacity: 0.18;
  }` : ''}
  .corner-mark {
    position: absolute;
    top: 40px; left: 48px;
    font-family: 'Cormorant Garamond', serif;
    font-size: 20px;
    opacity: 0.5;
    letter-spacing: 1px;
  }
  .slide-num {
    position: absolute;
    bottom: 40px; right: 48px;
    font-size: 14px;
    opacity: 0.45;
    letter-spacing: 1px;
    font-weight: 300;
  }
  .accent-bar {
    width: 48px;
    height: 3px;
    background: ${accent};
    margin-bottom: 36px;
    ${slide.isHook ? 'margin: 0 auto 36px;' : ''}
  }
  .content {
    text-align: ${slide.isHook ? 'center' : 'left'};
    max-width: 860px;
    width: 100%;
  }
  .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 3px;
    opacity: 0.5;
    font-weight: 400;
    margin-bottom: 20px;
    color: ${accent};
  }
  .content p {
    font-family: 'Cormorant Garamond', serif;
    font-size: ${Math.min(slide.fontSize, 60)}px;
    line-height: 1.3;
    font-weight: ${slide.isHook ? 600 : 400};
    margin-bottom: 16px;
  }
  .content p:last-child { margin-bottom: 0; }
  ${slide.isCTA ? `
  .cta-tag {
    display: inline-block;
    margin-top: 32px;
    padding: 10px 28px;
    border: 1.5px solid ${slide.textColor};
    border-radius: 40px;
    font-family: 'Jost', sans-serif;
    font-size: 16px;
    font-weight: 500;
    letter-spacing: 1px;
    opacity: 0.85;
  }` : ''}
</style>
</head>
<body>
  ${photoB64 ? '<div class="photo-bg"></div>' : ''}
  <div class="corner-mark">TableClinic</div>
  <div class="slide-num">${index + 1} / ${total}</div>
  <div class="accent-bar"></div>
  <div class="content">
    <div class="label">${slide.label}</div>
    ${textLines}
    ${slide.isCTA ? `<div class="cta-tag">Salve para não esquecer ✦</div>` : ''}
  </div>
</body>
</html>`;
}

async function generateCarousel(rawContent, cardId, driveFolderUrl) {
  const slides = parseSlides(rawContent);
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

    for (let i = 0; i < slides.length; i++) {
      // Distribui fotos pelos slides (uma por slide, ciclando se necessário)
      const photo = photos.length > 0 ? photos[i % photos.length] : null;
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

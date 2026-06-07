const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const TMP_DIR = path.join(__dirname, '../../tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Paleta e tipografia TableClinic
const THEME = {
  verde:     '#3D4A35',
  bege:      '#F8F4EE',
  terracota: '#B97040',
  branco:    '#FFFFFF',
};

// Parseia o texto do Claude em slides estruturados
function parseSlides(rawContent) {
  const slides = [];
  const lines = rawContent.split('\n');
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detecta cabeçalho de slide: "SLIDE 1", "SLIDE FINAL", "VÍDEO DE CAPA"
    const slideMatch = trimmed.match(/^(SLIDE\s*\d+|SLIDE\s+FINAL|VÍ?DEO\s+DE\s+CAPA)[:\s]*(.*)?$/i);
    if (slideMatch) {
      if (current) slides.push(current);
      current = {
        label: slideMatch[1].toUpperCase(),
        text: slideMatch[2]?.trim() || '',
        bg: THEME.verde,
        textColor: THEME.bege,
        fontSize: 48,
        isHook: slideMatch[1].match(/SLIDE\s*1/i) !== null,
        isCTA: slideMatch[1].match(/FINAL/i) !== null,
      };
      continue;
    }

    if (!current) continue;

    // Detecta cor de fundo sugerida
    const bgMatch = trimmed.match(/cor\s+de\s+fundo[:\s]*([#\w]+)/i);
    if (bgMatch) {
      const raw = bgMatch[1].trim();
      // fix CSS injection: aceitar apenas hex válido ou nomes do tema
      const safeColor = /^#[0-9a-fA-F]{3,6}$/.test(raw)
        ? raw
        : (THEME[raw.toLowerCase()] || null);
      if (safeColor) {
        current.bg = safeColor;
        current.textColor = current.bg === THEME.bege ? THEME.verde : THEME.bege;
      }
      continue;
    }

    // Detecta tamanho de fonte sugerido
    const sizeMatch = trimmed.match(/tamanho[:\s]*(\d+)/i);
    if (sizeMatch) { current.fontSize = parseInt(sizeMatch[1], 10); continue; }

    // Acumula o texto do slide
    if (trimmed && !trimmed.match(/^(especificaç|fonte:|visual:|fundo:)/i)) {
      current.text += (current.text ? '\n' : '') + trimmed;
    }
  }

  if (current) slides.push(current);

  // Fallback: se parsing não gerou nenhum slide, quebra por parágrafos
  if (slides.length === 0) {
    const chunks = rawContent.split(/\n{2,}/).filter(c => c.trim());
    chunks.forEach((chunk, i) => {
      const isFirst = i === 0;
      const isLast  = i === chunks.length - 1;
      slides.push({
        label: isFirst ? 'SLIDE 1' : isLast ? 'SLIDE FINAL' : `SLIDE ${i + 1}`,
        text: chunk.trim(),
        bg: isFirst || isLast ? THEME.verde : THEME.bege,
        textColor: isFirst || isLast ? THEME.bege : THEME.verde,
        fontSize: isFirst ? 52 : 40,
        isHook: isFirst,
        isCTA: isLast,
      });
    });
  }

  return slides;
}

function buildSlideHtml(slide, index, total) {
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

async function generateCarousel(rawContent, cardId) {
  const slides = parseSlides(rawContent);
  if (slides.length === 0) throw new Error('Nenhum slide detectado no conteúdo');

  const sessionDir = path.join(TMP_DIR, `carousel_${cardId}_${Date.now()}`);
  fs.mkdirSync(sessionDir);

  // fix: remover --disable-web-security (desnecessário — fontes são carregadas via Google CDN
  // que não requer CORS no contexto headless; se necessário, usar --host-resolver-rules)
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const imagePaths = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 }); // 2x = 2160px qualidade

    for (let i = 0; i < slides.length; i++) {
      const html = buildSlideHtml(slides[i], i, slides.length);
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15_000 });

      // Aguarda fontes do Google carregarem
      await page.evaluateHandle('document.fonts.ready');

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
    const archive = archiver('zip', { zlib: { level: 6 } });
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

module.exports = { generateCarousel, cleanTmp };

// Testes das camadas geométricas/determinísticas do enhance de vídeo.
// Sem dependência externa: `node --test test/`.
const test = require('node:test');
const assert = require('node:assert');
const VE = require('../src/services/videoEnhance');

const W = 1080, H = 1920;

function parseAss(ass) {
  const styles = {};
  const events = [];
  for (const line of ass.split('\n')) {
    if (line.startsWith('Style: ')) {
      const f = line.slice(7).split(',');
      styles[f[0]] = { fontSize: +f[2], alignment: +f[18], marginL: +f[19], marginR: +f[20], marginV: +f[21] };
    } else if (line.startsWith('Dialogue: ')) {
      const f = line.slice(10).split(',');
      events.push({ layer: +f[0], start: f[1], end: f[2], style: f[3], text: f.slice(9).join(',') });
    }
  }
  return { styles, events };
}
const toSec = t => { const [h, m, s] = t.split(':'); return +h * 3600 + +m * 60 + parseFloat(s); };

const BLOCKS = [
  { start: 0.4, end: 2.2, text: 'a', lines: ['Voce sabia que a', 'sua cor'] },
  { start: 2.4, end: 4.2, text: 'b', lines: ['diz muito sobre voce?'] },
  { start: 8.2, end: 10.2, text: 'c', lines: ['Faz o quiz no link', 'da bio'] },
];
const baseCfg = {
  videoW: W, videoH: H, videoDurationS: 12, maxCharsPerLine: 22,
  visualHook: 'Sua cor diz mais', visualHookDurationS: 5,
};

test('resolveSafeZone devolve a caixa do Reels em pixels', () => {
  const sz = VE.resolveSafeZone(W, H, 'reels');
  assert.equal(sz.top, 250);
  assert.equal(sz.bottom, 422);
  assert.equal(sz.side, 140);          // simétrico = max(esquerda, direita)
  assert.equal(sz.boxW, 800);
  assert.equal(sz.boxH, 1248);
  // preset desconhecido cai em reels
  assert.equal(VE.resolveSafeZone(W, H, 'nao-existe').preset, 'reels');
});

test('com zona segura, legenda e hook ficam dentro da caixa', () => {
  const sz = VE.resolveSafeZone(W, H, 'reels');
  const { styles } = parseAss(VE.buildAss(BLOCKS, { ...baseCfg, safeZone: true }));

  // legenda ancorada na base da caixa segura, nunca abaixo dela
  assert.ok(styles.Default.marginV >= sz.bottom, 'legenda invade a faixa de baixo');
  assert.ok(styles.Default.marginL >= sz.side && styles.Default.marginR >= sz.side, 'legenda invade as laterais');

  // hook acima da legenda e com o topo dentro da caixa (3 linhas no pior caso)
  const hookLineH = styles.Hook.fontSize * 1.25;
  assert.ok(styles.Hook.marginV > styles.Default.marginV, 'hook deveria ficar acima da legenda');
  assert.ok(H - styles.Hook.marginV - hookLineH * 3 >= sz.top, 'hook invade a faixa de cima');
});

test('sem zona segura o layout legado é preservado', () => {
  const { styles } = parseAss(VE.buildAss(BLOCKS, baseCfg));
  assert.equal(styles.Default.marginV, Math.round(H * 0.18));
  assert.equal(styles.Default.marginL, Math.round(W * 0.10));
  assert.equal(styles.Hook.marginV, Math.round(H * 0.29));
});

test('bloco de CTA entra no fim e a legenda sai de cena', () => {
  const cfg = { ...baseCfg, safeZone: true, cta: { enabled: true, text: 'Clique abaixo e faca seu teste gratuito!', durationS: 3, arrow: true } };
  const { styles, events } = parseAss(VE.buildAss(BLOCKS, cfg));
  const ctaStart = 12 - 3;

  const cta = events.filter(e => e.style === 'Cta');
  assert.equal(cta.length, 1);
  assert.equal(toSec(cta[0].start), ctaStart);
  assert.equal(toSec(cta[0].end), 12);

  // nenhuma legenda sobrevive dentro da janela do CTA
  for (const e of events.filter(e => e.style === 'Default')) {
    assert.ok(toSec(e.end) <= ctaStart + 1e-6, `legenda ${e.start}-${e.end} invade a janela do CTA`);
  }

  // texto do CTA acima da seta, e a seta acima da linha da zona segura
  const sz = VE.resolveSafeZone(W, H, 'reels');
  assert.ok(styles.Cta.marginV > sz.bottom, 'texto do CTA deveria ficar acima da seta');
  const arrows = events.filter(e => e.style === 'CtaArrow');
  assert.ok(arrows.length >= 2, 'seta precisa de pelo menos um ciclo de batida');
  for (const a of arrows) {
    const m = a.text.match(/\\move\((\d+),(\d+),(\d+),(\d+),/);
    assert.ok(m, 'seta sem \\move');
    const lowest = Math.max(+m[2], +m[4]) + Math.round(H * 0.05 / 2);
    assert.ok(lowest <= H - sz.bottom, 'seta invade a faixa coberta pela UI');
  }
  // a seta é vetor (\p1), não glifo — independe da fonte instalada
  assert.ok(arrows[0].text.includes('\\p1'));
});

test('CTA sem seta encosta o texto na base da zona segura', () => {
  const cfg = { ...baseCfg, safeZone: true, cta: { enabled: true, text: 'Faca o teste', durationS: 3, arrow: false } };
  const { styles, events } = parseAss(VE.buildAss(BLOCKS, cfg));
  assert.equal(styles.Cta.marginV, VE.resolveSafeZone(W, H, 'reels').bottom);
  assert.equal(events.filter(e => e.style === 'CtaArrow').length, 0);
});

test('overlay funciona sem nenhuma legenda (só hook + CTA)', () => {
  const cfg = { ...baseCfg, safeZone: true, cta: { enabled: true, text: 'Clique abaixo', durationS: 3, arrow: true } };
  const { events } = parseAss(VE.buildAss([], cfg));
  assert.equal(events.filter(e => e.style === 'Hook').length, 1);
  assert.equal(events.filter(e => e.style === 'Cta').length, 1);
  assert.equal(events.filter(e => e.style === 'Default').length, 0);
});

test('detectOfferMoment recua até o início da frase da oferta', () => {
  const mk = (text, start, end, sentenceEnd) => ({ text, start, end, sentenceEnd });
  const words = [
    mk('Eu', 5.0, 5.2), mk('montei', 5.2, 5.6), mk('um', 5.6, 5.7), mk('material', 5.7, 6.3), mk('completo', 6.3, 6.9, true),
    mk('Faz', 8.2, 8.5), mk('o', 8.5, 8.6), mk('quiz', 8.6, 9.0), mk('no', 9.0, 9.2), mk('link', 9.2, 9.6),
  ];
  const det = VE.detectOfferMoment(words, 11);
  assert.equal(det.keyword, 'quiz');
  assert.ok(Math.abs(det.at - 8.08) < 0.01, `esperado ~8.08, veio ${det.at}`);

  // menção só no comeco do video é ignorada (não é virada de oferta)
  assert.equal(VE.detectOfferMoment([mk('quiz', 0.5, 1.0), mk('oi', 5, 5.4)], 11), null);
  // sem menção nenhuma
  assert.equal(VE.detectOfferMoment([mk('bom', 8, 8.4), mk('dia', 8.4, 8.9)], 11), null);
  assert.equal(VE.detectOfferMoment([], 11), null);
});

test('buildHardCutFilter é degrau, não rampa', () => {
  const f = VE.buildHardCutFilter(8.08, { w: W, h: H });
  assert.ok(f.includes('gte(t\\,8.080)'), 'deveria comparar contra o instante do corte');
  assert.ok(f.endsWith(`scale=${W}:${H}`), 'deveria voltar ao tamanho original');
  assert.ok(!f.includes('/0.5'), 'não deveria ter rampa');
  assert.equal(VE.buildHardCutFilter(0, { w: W, h: H }), null);
  assert.equal(VE.buildHardCutFilter(8, { w: null, h: null }), null);
});

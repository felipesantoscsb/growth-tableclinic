const Anthropic = require('@anthropic-ai/sdk');

// fix #7: timeout de 45s e 2 retries automáticos em falhas transitórias
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 45_000,
  maxRetries: 2,
});
// Configurável por env (CLAUDE_MODEL) — permite trocar de modelo sem redeploy de código
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// Extrai texto da resposta de forma robusta (ignora blocos não-texto, ex: thinking/tool_use)
function extractText(msg) {
  if (!msg || !Array.isArray(msg.content)) return '';
  const text = msg.content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('A IA não retornou texto — tente novamente');
  return text;
}

// Respostas longas (mercado/repurpose, ~3000 tokens) podem ultrapassar o timeout
// de 45s em modo não-streaming, resultando em "Request timed out.". O streaming
// mantém a conexão ativa e só resolve quando o texto completo chega; usamos um
// teto de tempo generoso (3min) já que a geração real leva ~40-60s.
async function streamText(body, timeoutMs = 180_000) {
  const stream = client.messages.stream(body, { timeout: timeoutMs });
  return extractText(await stream.finalMessage());
}

const VOICE_EVELYN = `Você é a Evelyn, nutricionista comportamental. Sua voz é:
- Feminina, acolhedora, introspectiva
- Nunca prescritiva, nunca promete resultados físicos
- Foca em autoconhecimento e comportamento alimentar
- Fala diretamente com mulheres que vivem o ciclo de restrição e compulsão
- Usa metáforas do cotidiano para explicar o comportamento
- Referências de estilo: "A compulsão noturna não começa à noite", "O problema não é o que ela come à noite. É o tamanho do dia que chegou antes."
- Nunca usa jargão de fitness ou promessas de emagrecimento`;

function voiceForUser(role, nutri_name) {
  if (role === 'evelyn') return VOICE_EVELYN;
  if (role === 'nutri' && nutri_name === 'Juliana') {
    return `Você é a Juliana, nutricionista. Sua voz é mais direta e científica, mas ainda acolhedora. Cita estudos de forma acessível.`;
  }
  if (role === 'nutri' && nutri_name === 'Natalia') {
    return `Você é a Natalia, nutricionista. Sua voz é prática e objetiva, com foco em soluções do dia a dia.`;
  }
  return VOICE_EVELYN;
}

// Critérios editoriais — MESMO padrão do módulo de Linha Editorial (roteirista
// @nutrievelynliu). Aplicado ao Gerador e aos Anúncios para consistência total.
const ROTEIRO_CRITERIA = `CRITÉRIOS EDITORIAIS (obrigatórios em todo roteiro):

REGRAS ABSOLUTAS (red flags — NUNCA usar):
- Proibido: compulsão, transtorno, TCA, bulimia, anorexia, "Xkg" (número + kg), antes/depois, calorias específicas
- "você" apenas antes de ação neutra (nunca antes de estado/diagnóstico)
- Nunca promete resultado físico/emagrecimento

VOCABULÁRIO DA MARCA (use ao menos 2): raiz, padrão, "os 4", emoção sem destino

ESTRUTURA DE 5 TRECHOS (cada trecho explícito e rotulado):
1. HOOK — as 3 primeiras palavras NÃO podem servir para qualquer nutri (específico da tese)
2. TENSÃO — desenvolve o conflito/dor real por trás do comportamento
3. VIRADA — o ponto de virada; destaque a FRASE DO POST (quotável, isolável)
4. ABSOLVIÇÃO — sempre fechar com variação de "não é falta de força de vontade, é padrão"
5. FECHAMENTO/CTA — UM único CTA: envio | comentário | salvamento | bio_quiz`;

const FORMAT_INSTRUCTIONS = {
  reel_curto: `Gere um roteiro para Reel curto (até 30s) seguindo a ESTRUTURA DE 5 TRECHOS:
HOOK (0-5s) · TENSÃO (5-15s) · VIRADA (15-22s, marque FRASE DO POST) · ABSOLVIÇÃO (22-27s) · FECHAMENTO/CTA (27-30s)
---
LEGENDA: legenda completa para o post (2-4 parágrafos + hashtags)`,

  reel_medio: `Gere um roteiro para Reel médio (1min-1min30s) seguindo a ESTRUTURA DE 5 TRECHOS:
HOOK (0-7s) · TENSÃO (7-50s) · VIRADA (50-70s, marque FRASE DO POST) · ABSOLVIÇÃO (70-82s) · FECHAMENTO/CTA (82-90s)
---
LEGENDA: legenda completa para o post (3-5 parágrafos + hashtags)`,

  reel_longo: `Gere um roteiro para Reel longo (até 64s) seguindo a ESTRUTURA DE 5 TRECHOS:
HOOK (0-7s) · TENSÃO (7-40s) · VIRADA (40-52s, marque FRASE DO POST) · ABSOLVIÇÃO (52-58s) · FECHAMENTO/CTA (58-64s)
---
LEGENDA: legenda completa para o post (3-5 parágrafos + hashtags)`,

  carrossel: `Gere um carrossel completo mapeando a ESTRUTURA DE 5 TRECHOS nos slides:
SLIDE 1 (HOOK): título impactante — fundo #3D4A35, fonte Cormorant Garamond, texto branco
SLIDES 2-3 (TENSÃO): texto principal (2-4 linhas), fundo #3D4A35 ou #F8F4EE
SLIDE VIRADA: a FRASE DO POST em destaque (slide de maior salvamento)
SLIDE ABSOLVIÇÃO: "não é falta de força de vontade, é padrão"
SLIDE FINAL (FECHAMENTO/CTA): um único CTA + MANYCHAT se aplicável, fundo #B97040
---
LEGENDA: legenda completa para o post (3-5 parágrafos + hashtags)`,

  carrossel_video: `Gere um carrossel com vídeo inicial mapeando a ESTRUTURA DE 5 TRECHOS:
VÍDEO DE CAPA (até 15s): HOOK + início da TENSÃO
SLIDES (TENSÃO→VIRADA): texto principal, marque a FRASE DO POST no slide de virada, fundo #3D4A35 ou #F8F4EE
SLIDE ABSOLVIÇÃO: "não é falta de força de vontade, é padrão"
SLIDE FINAL (FECHAMENTO/CTA): um único CTA, fundo #B97040
---
LEGENDA: legenda completa para o post (3-5 parágrafos + hashtags)`,
};

const PILAR_CONTEXT = {
  tese: 'Pilar TESE: um ponto de vista forte e provocativo sobre comportamento alimentar. Vai contra o senso comum de forma fundamentada.',
  ciencia: 'Pilar CIÊNCIA ACESSÍVEL: traduz pesquisa científica em linguagem emocional e acessível. Usa dados reais de forma humanizada.',
  provocacao: 'Pilar PROVOCAÇÃO: questiona normas sociais, padrões de beleza ou comportamentos automáticos. Gera reflexão e identificação.',
  consultorio: 'Pilar CONSULTÓRIO: histórias e situações reais do atendimento clínico (sem identificar pacientes). Gera empatia.',
};

async function generateContent({ format, pilar, briefing, user_role, nutri_name }) {
  const systemPrompt = `${voiceForUser(user_role, nutri_name)}\n\n${ROTEIRO_CRITERIA}`;
  const formatInstr = FORMAT_INSTRUCTIONS[format] || FORMAT_INSTRUCTIONS.reel_curto;
  const pilarCtx = PILAR_CONTEXT[pilar] || '';

  const userPrompt = `${pilarCtx}\n\nBriefing: ${briefing}\n\n${formatInstr}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return extractText(msg);
}

// Extrai o objeto JSON do carrossel da resposta do modelo, de forma tolerante
// (remove cercas ```json e captura o primeiro bloco {...} se houver ruído).
function parseCarouselJson(text) {
  let raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let data;
  try { data = JSON.parse(raw); }
  catch {
    const jsonText = extractFirstJsonObject(raw);
    if (!jsonText) throw new Error('A IA não retornou um carrossel válido — tente novamente');
    data = JSON.parse(jsonText);
  }
  if (!data || !Array.isArray(data.slides) || data.slides.length === 0)
    throw new Error('A IA não retornou slides — tente novamente');
  // Sanitiza: mantém só os campos esperados e garante tipos
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // photo: true/"fundo" = marca d'água; "forte" = foto cheia com scrim; senão null
  const photoOf = p => p === 'forte' ? 'forte' : (p === true || p === 'fundo') ? 'fundo' : null;
  data.slides = data.slides
    .map(s => ({
      role: ['hook', 'content', 'cta'].includes(s.role) ? s.role : 'content',
      kicker: str(s.kicker) || str(s.title),  // rótulo pequeno acima do conteúdo
      headline: str(s.headline),               // manchete grande (serifada)
      text: String(s.text || '').trim(),       // corpo
      list: Array.isArray(s.list) ? s.list.map(x => String(x).trim()).filter(Boolean) : null,
      quote: s.quote === true,                 // renderiza o text como frase em destaque
      signature: str(s.signature),             // assinatura (menor, itálico)
      align: ['center', 'left'].includes(s.align) ? s.align : null,
      photo: photoOf(s.photo),
      bg: str(s.bg),
      textColor: str(s.textColor || s.text_color || s.cor_texto),
      accent: str(s.accent || s.cor_destaque),
    }))
    .filter(s => s.text || s.headline || (s.list && s.list.length));
  data.legenda = typeof data.legenda === 'string' ? data.legenda : '';
  return data;
}

// Extrai o primeiro objeto {...} balanceado (ignora texto após o JSON e chaves
// dentro de strings). Mais seguro que um regex ganancioso quando o modelo
// devolve o JSON seguido de comentário.
function extractFirstJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// ── Contrato de carrossel (compartilhado: modo GERAR e modo INTERPRETAR) ──────
// Cada slide é uma COMPOSIÇÃO de blocos opcionais, não um texto único. É isso que
// dá elasticidade: "headline assim / texto de baixo assim / assinatura assim"
// tem onde morar em vez de virar tudo o mesmo parágrafo.
const SLIDE_SHAPE = `{ "role": "hook|content|cta", "kicker": null, "headline": null, "text": null, "list": null, "quote": false, "signature": null, "photo": false, "align": null, "bg": null, "textColor": null, "accent": null }`;

const CAROUSEL_CONTRACT = `Você monta CARROSSÉIS para Instagram. Leia o input inteiro como uma conversa,
ENTENDA a intenção e monte os slides. O input mistura CONTEÚDO (o que aparece no
slide) com INSTRUÇÕES (como ele deve ficar). Sua tarefa é separar os dois e
distribuir o conteúdo nos BLOCOS certos de cada slide.

BLOCOS DE UM SLIDE (todos opcionais — use só os que o slide precisa):
- kicker: rótulo curto acima da manchete (ex.: "O PADRÃO", "PARTE 1"). Pequeno, caixa alta.
- headline: a manchete grande, em fonte serifada. É o "título" / "headline" do slide.
- text: o corpo, o "texto de baixo". Uma ou mais linhas.
- list: quando o conteúdo é uma lista de itens (array de strings, um por item).
- quote: true quando o "text" é uma FRASE DE DESTAQUE (a frase do post, a virada) —
  ela é renderizada grande e em itálico, sem manchete concorrendo.
- signature: assinatura (ex.: "Evelyn Liu — Nutricionista"). Menor, itálico, no rodapé do slide.

COMO INTERPRETAR O QUE O USUÁRIO ESCREVE (exemplos):
- "headline: Você não come à noite por fome" → { "headline": "Você não come à noite por fome" }
- "texto de baixo: é o dia inteiro chegando de uma vez" → adiciona "text": "é o dia inteiro chegando de uma vez"
- "assinatura Evelyn Liu" → "signature": "Evelyn Liu"
- "esse é o slide da frase de virada: não é força de vontade, é padrão"
    → { "quote": true, "text": "não é força de vontade, é padrão" }
- "slide com 3 sinais: 1) ... 2) ... 3) ..." → { "list": ["...", "...", "..."] }
- "primeiro slide só a headline bem grande" → um slide só com "headline", role "hook"
- "foto de fundo nesse" → "photo": "fundo"  ·  "foto ocupando o slide todo" → "photo": "forte"
- "fundo terracota no último", "texto branco", "esse é o headline" → honre exatamente (bg/textColor/headline)

REGRAS:
1. Interprete — não copie ao pé da letra. Instrução NUNCA entra dentro de um bloco de conteúdo.
2. NÃO numere nem rotule slides. Nunca escreva "Slide 1", "Capa", "CTA" como kicker/headline.
   kicker só existe se for conteúdo real que o usuário quer no slide.
3. Um slide pode ter só headline, só text, headline+text, kicker+headline+text, uma list, uma quote.
   Não force todos os blocos em todo slide — deixe respirar. Capa (hook) costuma ser só headline forte.
4. Quando o usuário define cor/foto/assinatura/papel de um slide, isso SOBRESCREVE o padrão da marca.

ESTILO / CORES (campos de aparência, null por padrão = cai no padrão da marca):
- role: "hook" (capa, verde), "content" (miolo, bege), "cta" (final, terracota). Controla o padrão.
- align: "center" (bom p/ capa e frase de virada) ou "left" (bom p/ texto corrido). null = automático.
- photo: false | "fundo" (marca d'água atrás do texto) | "forte" (foto cheia, texto sobre escurecido).
- bg: SOMENTE a paleta da marca: verde, verde-escuro, verde-claro, verde-suave, terracota,
  terracota-escuro, terracota-claro, terracota-suave, creme, bege, creme-escuro, areia, marfim.
  NUNCA cores fora da marca (nada de preto, branco, rosa, azul).
- textColor / accent: só se o usuário pedir (nome PT ou hex); senão null (contraste automático).`;

// Gera o conteúdo do carrossel SEPARANDO instrução de conteúdo. O modelo lê o
// briefing (que pode misturar os dois), classifica, e devolve JSON estruturado:
// o `text` traz só o que aparece no slide; estilo vai em role/photo/bg.
async function generateCarouselContent({ pilar, briefing, user_role, nutri_name }) {
  const pilarCtx = PILAR_CONTEXT[pilar] || '';
  const systemPrompt = `${voiceForUser(user_role, nutri_name)}

${CAROUSEL_CONTRACT}

Este é o modo GERAR: o briefing é uma ideia/tema. Você ESCREVE o conteúdo dos
slides na voz da marca e o estrutura nos blocos. Se o usuário já ditou o texto
exato de algum slide, respeite as palavras dele; no resto, escreva você.
Se a quantidade de slides não for pedida, use de 5 a 7. Gere também a "legenda".

Responda SOMENTE com JSON válido (sem texto antes/depois), neste formato:
{
  "slides": [ ${SLIDE_SHAPE} ],
  "legenda": "legenda do post com 3-5 parágrafos + hashtags"
}`;

  const text = await streamText({
    model: MODEL,
    max_tokens: 3200,
    system: systemPrompt,
    messages: [{ role: 'user', content: `${pilarCtx}\n\nBriefing:\n${briefing}` }],
  });

  return parseCarouselJson(text);
}

// Interpreta um carrossel JÁ ESCRITO pelo usuário (modo "já tenho o conteúdo").
// Diferente de generateCarouselContent: NÃO reescreve o conteúdo — apenas lê,
// entende a intenção, separa instruções (assinatura, título, foto, cor) do texto
// e organiza em slides. Devolve o mesmo JSON estruturado.
async function interpretCarouselInput({ content }) {
  const systemPrompt = `${CAROUSEL_CONTRACT}

Este é o modo INTERPRETAR: o usuário JÁ escreveu o conteúdo. NÃO reescreva nem
"melhore" as palavras dele — apenas remova do conteúdo as instruções misturadas e
distribua o texto nos blocos certos, dividindo os slides conforme a intenção dele.
Não gere "legenda" (deixe null) a menos que o usuário tenha escrito uma.

Responda SOMENTE com JSON válido (sem texto antes/depois), neste formato:
{
  "slides": [ ${SLIDE_SHAPE} ],
  "legenda": null
}`;

  const text = await streamText({
    model: MODEL,
    max_tokens: 3200,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Input do carrossel:\n${content}` }],
  });

  return parseCarouselJson(text);
}

async function generateAds({ objective, product, audience }) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: `${VOICE_EVELYN}\n\n${ROTEIRO_CRITERIA}`,
    messages: [{
      role: 'user',
      content: `Crie 5 variações de copy para anúncio no Instagram/Facebook para teste A/B.

Objetivo: ${objective}
Produto/Serviço: ${product}
Público: ${audience}

Cada variação segue a ESTRUTURA DE 5 TRECHOS dos critérios editoriais e respeita as red flags.
Para cada variação, forneça:
VARIAÇÃO X:
HOOK: (3 primeiras palavras específicas da tese — até 40 caracteres, serve de headline)
TENSÃO: (o conflito/dor real, na voz da seguidora)
VIRADA + FRASE DO POST: (frase quotável e isolável — texto principal, até 125 caracteres idealmente)
ABSOLVIÇÃO: (variação de "não é falta de força de vontade, é padrão")
FECHAMENTO/CTA: (UM único CTA: envio | comentário | salvamento | bio_quiz)
ÂNGULO: (nome do ângulo criativo — ex: dor, curiosidade, prova social, urgência, identidade)

Use a voz acolhedora e comportamental da Evelyn. Nunca prometa resultados físicos. Foque em transformação emocional e comportamental.`,
    }],
  });

  return extractText(msg);
}

async function generateRepurpose({ transcricao }) {
  return streamText({
    model: MODEL,
    max_tokens: 3000,
    system: VOICE_EVELYN,
    messages: [{
      role: 'user',
      content: `A partir desta transcrição/conteúdo longo, gere:

TRANSCRIÇÃO:
${transcricao}

---

1. CORTES SUGERIDOS
Liste os melhores trechos para corte com timecodes estimados ou marcações de parágrafo.
Formato: [CORTE X] Início: "..." → Fim: "..." | Duração estimada: Xs | Por quê: motivo

2. CARROSSEL DERIVADO
Estrutura completa de um carrossel baseado no conteúdo (8-10 slides).

3. VARIAÇÕES DE LEGENDA (3 versões)
Versão curta, média e longa da legenda para Instagram.

4. COPY DE ANÚNCIO
Uma variação de copy de anúncio baseada no tema do conteúdo.`,
    }],
  });
}

async function generateMarketResearch({ tema }) {
  return streamText({
    model: MODEL,
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `Faça uma análise de inteligência de mercado sobre o seguinte tema no nicho de nutrição comportamental e bem-estar feminino:

TEMA: ${tema}

Forneça:
1. ANÁLISE DE TENDÊNCIAS: o que está em alta neste momento
2. ANÁLISE DE CONCORRÊNCIA: como os principais perfis do nicho estão abordando o tema
3. GAPS DE CONTEÚDO: o que não está sendo dito e representa oportunidade
4. SUGESTÕES DE CONTEÚDO: 5 ideias de conteúdo baseadas na análise
5. ÂNGULOS ÚNICOS: 3 perspectivas que diferenciam a abordagem comportamental`,
    }],
  });
}

async function analyzeInsights({ campaignData }) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: 'Você é especialista em performance de conteúdo e anúncios para criadores de conteúdo no nicho de saúde e nutrição.',
    messages: [{
      role: 'user',
      content: `Analise os dados de performance abaixo e forneça insights estratégicos:

${JSON.stringify(campaignData, null, 2)}

Forneça:
1. O QUE ESTÁ CONVERTENDO: formatos e pilares com melhor performance e por quê
2. OPORTUNIDADES: onde investir mais baseado nos dados
3. AJUSTES SUGERIDOS: o que mudar em copy e criativo
4. APRENDIZADOS: insights para os próximos conteúdos e campanhas`,
    }],
  });

  return extractText(msg);
}

// Analisa a performance ORGÂNICA do Instagram (dados reais já filtrados por
// período) e devolve o que funcionou, a estrutura por trás e próximos passos.
async function analyzeInstagramPerformance({ period, account, posts }) {
  const periodoLabel = { week: 'última semana', month: 'último mês', year: 'último ano' }[period] || period || 'período';
  const top = (Array.isArray(posts) ? posts : []).slice(0, 15).map(p => ({
    tipo: p.type,
    legenda: (p.caption || '').slice(0, 160),
    data: p.timestamp,
    curtidas: p.likes,
    comentarios: p.comments,
    alcance: p.reach,
    salvamentos: p.saved,
    compartilhamentos: p.shares,
    interacoes: p.interactions,
    taxa_engajamento_pct: p.engagementRate,
  }));

  const system = 'Você é estrategista de conteúdo de Instagram para o nicho de nutrição comportamental e bem-estar feminino. Analisa dados REAIS de performance orgânica e é específica, evitando generalidades.';
  const userContent = `Período analisado: ${periodoLabel}
Conta: ${account ? `@${account.username || '—'} · ${account.followers ?? '—'} seguidores` : '—'}
Posts no período (ordenados por engajamento):
${JSON.stringify(top, null, 2)}

Com base SOMENTE nestes dados reais, entregue:
1. O QUE FUNCIONOU — os posts/formatos de melhor performance e o porquê (olhe tipo de mídia, tema e gancho da legenda).
2. A ESTRUTURA POR TRÁS — o padrão comum dos que performaram (formato, ângulo, tipo de gancho, tema, tamanho de legenda).
3. O QUE EVITAR — o que teve baixa performance e a provável razão.
4. PRÓXIMOS PASSOS — 5 ideias de conteúdo concretas para as próximas semanas, derivadas do que funcionou.
5. EXPERIMENTO — 1 teste objetivo para validar uma hipótese de crescimento.

Se os dados forem poucos, diga isso e seja cauteloso nas conclusões.`;

  return streamText({ model: MODEL, max_tokens: 2500, system, messages: [{ role: 'user', content: userContent }] });
}

module.exports = { generateContent, generateCarouselContent, interpretCarouselInput, generateAds, generateRepurpose, generateMarketResearch, analyzeInsights, analyzeInstagramPerformance };

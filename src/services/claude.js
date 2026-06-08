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

const FORMAT_INSTRUCTIONS = {
  reel_curto: `Gere um roteiro para Reel curto (até 30s) com:
HOOK (0-7s): frase de impacto que para o scroll
DESENVOLVIMENTO (7-25s): conteúdo principal direto e emocionante
CTA (25-30s): chamada para ação clara
---
LEGENDA: legenda completa para o post (2-4 parágrafos + hashtags)`,

  reel_medio: `Gere um roteiro para Reel médio (1min-1min30s) com:
HOOK (0-7s): frase de impacto que para o scroll
DESENVOLVIMENTO (7-75s): narrativa com desenvolvimento emocional e racional
CTA (75-90s): chamada para ação clara
---
LEGENDA: legenda completa para o post (3-5 parágrafos + hashtags)`,

  reel_longo: `Gere um roteiro para Reel longo (até 64s) com:
HOOK (0-7s): frase de impacto que para o scroll
DESENVOLVIMENTO (7-57s): conteúdo aprofundado com exemplos e dados
CTA (57-64s): chamada para ação clara
---
LEGENDA: legenda completa para o post (3-5 parágrafos + hashtags)`,

  carrossel: `Gere um carrossel completo com:
SLIDE 1 (HOOK): título impactante — fundo #3D4A35, fonte Cormorant Garamond, texto branco
SLIDES 2-8 (DESENVOLVIMENTO): cada slide com: texto principal (2-4 linhas), especificação visual (cor de fundo: #3D4A35 ou #F8F4EE, fonte: Cormorant Garamond, tamanho sugerido)
SLIDE FINAL (CTA): chamada para ação + palavra MANYCHAT se aplicável, fundo #B97040
---
LEGENDA: legenda completa para o post (3-5 parágrafos + hashtags)`,

  carrossel_video: `Gere um carrossel com vídeo inicial:
VÍDEO DE CAPA (até 15s): roteiro do vídeo de capa
SLIDES 2-8 (DESENVOLVIMENTO): cada slide com: texto principal, especificação visual (cor de fundo: #3D4A35 ou #F8F4EE, fonte: Cormorant Garamond)
SLIDE FINAL (CTA): chamada para ação, fundo #B97040
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
  const systemPrompt = voiceForUser(user_role, nutri_name);
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
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('A IA não retornou um carrossel válido — tente novamente');
    data = JSON.parse(m[0]);
  }
  if (!data || !Array.isArray(data.slides) || data.slides.length === 0)
    throw new Error('A IA não retornou slides — tente novamente');
  // Sanitiza: mantém só os campos esperados e garante tipos
  data.slides = data.slides
    .map(s => ({
      role: ['hook', 'content', 'cta'].includes(s.role) ? s.role : 'content',
      text: String(s.text || '').trim(),
      photo: s.photo === true,
      bg: typeof s.bg === 'string' && s.bg.trim() ? s.bg.trim() : null,
    }))
    .filter(s => s.text);
  data.legenda = typeof data.legenda === 'string' ? data.legenda : '';
  return data;
}

// Gera o conteúdo do carrossel SEPARANDO instrução de conteúdo. O modelo lê o
// briefing (que pode misturar os dois), classifica, e devolve JSON estruturado:
// o `text` traz só o que aparece no slide; estilo vai em role/photo/bg.
async function generateCarouselContent({ pilar, briefing, user_role, nutri_name }) {
  const pilarCtx = PILAR_CONTEXT[pilar] || '';
  const systemPrompt = `${voiceForUser(user_role, nutri_name)}

Você monta CARROSSÉIS para Instagram. O briefing do usuário pode MISTURAR:
- CONTEÚDO: o texto que deve aparecer nos slides;
- INSTRUÇÕES: formatação, cor de fundo, em qual slide usar foto, número de slides, etc.

Sua tarefa:
1. Leia o briefing e SEPARE instrução de conteúdo.
2. Escreva APENAS o texto que aparece em cada slide. NUNCA coloque instrução
   dentro do texto (nada de "fundo bege", "use foto aqui", "Cormorant", "tamanho 40").
3. As instruções vão SOMENTE nos campos estruturais (role, photo, bg).
4. Respeite a quantidade de slides se o briefing pedir; senão use de 5 a 7
   (1 capa + miolo + 1 CTA).

Responda SOMENTE com JSON válido, sem nenhum texto antes ou depois:
{
  "slides": [
    { "role": "hook|content|cta", "text": "texto que aparece no slide", "photo": false, "bg": null }
  ],
  "legenda": "legenda do post com 3-5 parágrafos + hashtags"
}
Regras dos campos:
- role: "hook" no primeiro slide, "cta" no último, "content" nos do meio.
- photo: true SÓ se o briefing pedir foto naquele slide; caso contrário false.
- bg: null para usar o padrão da marca; ou "verde"|"bege"|"terracota" se o briefing pedir cor específica.`;

  const text = await streamText({
    model: MODEL,
    max_tokens: 3000,
    system: systemPrompt,
    messages: [{ role: 'user', content: `${pilarCtx}\n\nBriefing:\n${briefing}` }],
  });

  return parseCarouselJson(text);
}

async function generateAds({ objective, product, audience }) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: VOICE_EVELYN,
    messages: [{
      role: 'user',
      content: `Crie 5 variações de copy para anúncio no Instagram/Facebook para teste A/B.

Objetivo: ${objective}
Produto/Serviço: ${product}
Público: ${audience}

Para cada variação, forneça:
VARIAÇÃO X:
HEADLINE: (até 40 caracteres)
TEXTO PRINCIPAL: (até 125 caracteres idealmente)
DESCRIÇÃO: (complemento opcional)
ÂNGULO: (nome do ângulo criativo usado — ex: dor, curiosidade, prova social, urgência, identidade)

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

module.exports = { generateContent, generateCarouselContent, generateAds, generateRepurpose, generateMarketResearch, analyzeInsights, analyzeInstagramPerformance };

const Anthropic = require('@anthropic-ai/sdk');

// fix #7: timeout de 45s e 2 retries automáticos em falhas transitórias
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 45_000,
  maxRetries: 2,
});
const MODEL = 'claude-sonnet-4-6';

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

  return msg.content[0].text;
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

  return msg.content[0].text;
}

async function generateRepurpose({ transcricao }) {
  const msg = await client.messages.create({
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

  return msg.content[0].text;
}

async function generateMarketResearch({ tema }) {
  const msg = await client.messages.create({
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

  return msg.content[0].text;
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

  return msg.content[0].text;
}

module.exports = { generateContent, generateAds, generateRepurpose, generateMarketResearch, analyzeInsights };

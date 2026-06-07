const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { ok, fail } = require('../middleware/respond');
const OpenAI = require('openai');

router.use(authMiddleware);

router.post('/video', async (req, res) => {
  try {
    const { video_url, instructions } = req.body;
    if (!video_url || !instructions) return fail(res, 'video_url e instructions obrigatórios', 400);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // OpenAI não tem endpoint direto de edição de vídeo por URL ainda;
    // Retornamos análise/roteiro de edição via GPT-4o como proxy útil
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'Você é um editor de vídeo especialista em conteúdo para Instagram. Analise as instruções e forneça um roteiro detalhado de edição com timecodes, cortes, legendas e efeitos recomendados.',
        },
        {
          role: 'user',
          content: `Vídeo: ${video_url}\n\nInstruções de edição: ${instructions}\n\nGere um roteiro completo de edição com:\n1. Lista de cortes com timecodes\n2. Legendas sugeridas por trecho\n3. Efeitos e transições recomendados\n4. Música de fundo sugerida\n5. Checklist de exportação (formato, resolução, fps)`,
        },
      ],
    });

    ok(res, {
      video_url,
      instructions,
      edit_plan: completion.choices[0].message.content,
      note: 'Plano de edição gerado. Para edição automatizada de vídeo, integre com ferramentas como Remotion ou FFmpeg conforme o roteiro acima.',
    });
  } catch (e) { fail(res, e.message); }
});

module.exports = router;

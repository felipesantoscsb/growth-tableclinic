const cron = require('node-cron');
const db = require('../models/db');
const { generateMarketResearch } = require('../services/claude');

async function sendWhatsApp(message) {
  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_BASE_URL, ADMIN_WHATSAPP } = process.env;
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN) {
    console.log('[WeeklyReport] ZAPI não configurado, pulando envio WhatsApp');
    return;
  }
  try {
    await fetch(`${ZAPI_BASE_URL}/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: ADMIN_WHATSAPP, message }),
    });
    console.log('[WeeklyReport] WhatsApp enviado para', ADMIN_WHATSAPP);
  } catch (e) {
    console.error('[WeeklyReport] Erro ao enviar WhatsApp:', e.message);
  }
}

async function runWeeklyReport() {
  console.log('[WeeklyReport] Gerando relatório semanal de tendências...');
  try {
    const content = await generateMarketResearch({
      tema: 'tendências semanais em nutrição comportamental, bem-estar feminino e comportamento alimentar no Instagram Brasil',
    });

    const { rows } = await db.query(
      `INSERT INTO market_reports (title, content) VALUES ($1, $2) RETURNING id`,
      [`Relatório Semanal — ${new Date().toLocaleDateString('pt-BR')}`, content]
    );

    const summary = content.slice(0, 800) + (content.length > 800 ? '...\n\n[Relatório completo salvo no sistema]' : '');
    await sendWhatsApp(`📊 *Relatório Semanal de Tendências — TableClinic*\n\n${summary}`);

    console.log('[WeeklyReport] Relatório gerado, id:', rows[0].id);
  } catch (e) {
    console.error('[WeeklyReport] Erro:', e.message);
  }
}

// Toda segunda-feira às 8h BRT (UTC-3 = 11h UTC)
function startWeeklyJob() {
  cron.schedule('0 11 * * 1', runWeeklyReport, { timezone: 'America/Sao_Paulo' });
  console.log('[WeeklyReport] Job agendado: toda segunda às 8h BRT');
}

module.exports = { startWeeklyJob, runWeeklyReport };

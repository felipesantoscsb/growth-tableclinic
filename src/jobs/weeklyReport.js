const cron = require('node-cron');
const db = require('../models/db');
const { generateMarketResearch } = require('../services/claude');

async function sendWhatsApp(message) {
  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, ZAPI_BASE_URL, ADMIN_WHATSAPP } = process.env;
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN) {
    console.log('[WeeklyReport] ZAPI não configurado (ZAPI_INSTANCE_ID, ZAPI_TOKEN e ZAPI_CLIENT_TOKEN obrigatórios), pulando envio WhatsApp');
    return;
  }
  try {
    const res = await fetch(`${ZAPI_BASE_URL}/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': ZAPI_CLIENT_TOKEN,
      },
      body: JSON.stringify({ phone: ADMIN_WHATSAPP, message }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[WeeklyReport] ZAPI erro HTTP', res.status, body);
      return;
    }
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

    // fix #8: buscar ID do admin para preencher created_by (evita NULL e quebra futura se NOT NULL)
    const { rows: adminRows } = await db.query(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
    const adminId = adminRows[0]?.id || null;

    const { rows } = await db.query(
      `INSERT INTO market_reports (title, content, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [`Relatório Semanal — ${new Date().toLocaleDateString('pt-BR')}`, content, adminId]
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

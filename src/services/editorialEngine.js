/**
 * Editorial Engine — core logic
 * CSV parse, LLM classify, analytics
 */
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../models/db');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 60_000,
  maxRetries: 2,
});
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// ── Taxonomia ───────────────────────────────────────────────────────────────
const EDITORIAS = [
  'canetas_noticia',
  'tipologico_absolvicao',
  'identidade',
  'historia_consultorio',
  'reflexao_collab',
  'outro',
];

// ── CSV Parser ──────────────────────────────────────────────────────────────
// Tolerante a: BOM UTF-8, aspas duplas escapadas (RFC 4180), descrições multilinha

function parseCSV(raw) {
  // Remove BOM
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  // Normalize CRLF
  raw = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const rows = [];
  let pos = 0;
  const len = raw.length;

  while (pos < len) {
    const row = [];
    // Parse each field of row
    while (pos < len) {
      if (raw[pos] === '"') {
        pos++; // skip opening quote
        let field = '';
        while (pos < len) {
          if (raw[pos] === '"') {
            if (pos + 1 < len && raw[pos + 1] === '"') {
              field += '"';
              pos += 2;
            } else {
              pos++; // skip closing quote
              break;
            }
          } else {
            field += raw[pos++];
          }
        }
        row.push(field);
      } else {
        let field = '';
        while (pos < len && raw[pos] !== ',' && raw[pos] !== '\n') {
          field += raw[pos++];
        }
        row.push(field.trim());
      }
      if (pos < len && raw[pos] === ',') {
        pos++;
      } else {
        break;
      }
    }
    if (pos < len && raw[pos] === '\n') pos++;
    if (row.length > 0 && !(row.length === 1 && row[0] === '')) {
      rows.push(row);
    }
  }

  return rows;
}

// Mapeamento de cabeçalho → campo interno
const COL_MAP = {
  'identificação do post':        'post_id',
  'identificação da conta':       'account_id',
  'nome de usuário da conta':     'account_username',
  'nome da conta':                'account_name',
  'descrição':                    'description',
  'duração (s)':                  'duration_s',
  'horário de publicação':        'published_at',
  'link permanente':              'permalink',
  'tipo de post':                 'post_type',
  'comentário de dados':          'data_comment',
  'data':                         'date',
  'visualizações':                'views',
  'alcance':                      'reach',
  'curtidas':                     'likes',
  'compartilhamentos':            'shares',
  'seguimentos':                  'follows',
  'comentários':                  'comments',
  'salvamentos':                  'saves',
};

function normalizeHeader(h) {
  return h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// COL_MAP com chaves normalizadas (sem acento) — o header do CSV também é
// normalizado, então a comparação precisa ser acento-insensível dos dois lados.
const COL_MAP_NORM = {};
for (const [k, v] of Object.entries(COL_MAP)) COL_MAP_NORM[normalizeHeader(k)] = v;

function parseInt_(v) {
  const n = parseInt(String(v).replace(/\D/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Converte CSV raw text → array de objetos normalizados.
 * Retorna { posts, warnings }
 */
function csvToObjects(csvText) {
  const warnings = [];
  const rows = parseCSV(csvText);
  if (rows.length < 2) return { posts: [], warnings: ['CSV vazio ou sem dados'] };

  // Header row
  const headers = rows[0].map(normalizeHeader);
  const colIdx = {};
  headers.forEach((h, i) => {
    const mapped = COL_MAP_NORM[h];
    if (mapped) colIdx[mapped] = i;
  });

  const required = ['post_id', 'account_username', 'reach'];
  for (const r of required) {
    if (colIdx[r] === undefined) warnings.push(`Coluna não encontrada: "${r}"`);
  }

  const posts = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every(c => !c)) continue; // linha vazia

    const get = field => (colIdx[field] !== undefined ? row[colIdx[field]] || '' : '');

    const username = get('account_username').toLowerCase().trim();
    // Só processar contas conhecidas
    if (username && username !== 'nutrievelynliu' && username !== 'evelynlwl') {
      warnings.push(`Linha ${i + 1}: conta desconhecida "${username}" — ignorada`);
      continue;
    }

    const postId = get('post_id');
    if (!postId) { warnings.push(`Linha ${i + 1}: sem post_id — ignorada`); continue; }

    // Parse data
    let publishedAt = null;
    const pubRaw = get('published_at');
    if (pubRaw) {
      const d = new Date(pubRaw);
      if (!isNaN(d)) publishedAt = d.toISOString();
    }

    let dateVal = null;
    const dateRaw = get('date');
    if (dateRaw) {
      // Pode vir como DD/MM/AAAA ou AAAA-MM-DD
      const parts = dateRaw.includes('/')
        ? dateRaw.split('/').reverse().join('-')
        : dateRaw;
      const d = new Date(parts);
      if (!isNaN(d)) dateVal = d.toISOString().slice(0, 10);
    }

    posts.push({
      post_id:          postId,
      account_username: username || 'nutrievelynliu',
      description:      get('description'),
      duration_s:       parseInt_(get('duration_s')),
      published_at:     publishedAt,
      permalink:        get('permalink'),
      post_type:        get('post_type'),
      date:             dateVal,
      views:            parseInt_(get('views')),
      reach:            parseInt_(get('reach')),
      likes:            parseInt_(get('likes')),
      shares:           parseInt_(get('shares')),
      follows:          parseInt_(get('follows')),
      comments:         parseInt_(get('comments')),
      saves:            parseInt_(get('saves')),
    });
  }

  return { posts, warnings };
}

// ── Upsert posts ────────────────────────────────────────────────────────────
async function upsertPosts(posts) {
  let inserted = 0, updated = 0;
  for (const p of posts) {
    const { rowCount, rows } = await db.query(
      `INSERT INTO editorial_posts
        (post_id, account_username, description, duration_s, published_at,
         permalink, post_type, date, views, reach, likes, shares, follows,
         comments, saves)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (post_id) DO UPDATE SET
         views       = EXCLUDED.views,
         reach       = EXCLUDED.reach,
         likes       = EXCLUDED.likes,
         shares      = EXCLUDED.shares,
         follows     = EXCLUDED.follows,
         comments    = EXCLUDED.comments,
         saves       = EXCLUDED.saves,
         description = EXCLUDED.description,
         updated_at  = NOW()
       RETURNING (xmax = 0) AS is_insert`,
      [p.post_id, p.account_username, p.description, p.duration_s,
       p.published_at, p.permalink, p.post_type, p.date,
       p.views, p.reach, p.likes, p.shares, p.follows, p.comments, p.saves]
    );
    if (rows[0]?.is_insert) inserted++; else updated++;
  }
  return { inserted, updated };
}

// ── LLM Classifier ─────────────────────────────────────────────────────────
const CLASSIFY_SYSTEM = `Você classifica posts do Instagram da @nutrievelynliu em editorias.

Editorias disponíveis:
- canetas_noticia: comentário de autoridade sobre medicamentos, GLP-1, Anvisa, lançamentos do nicho
- tipologico_absolvicao: os 4 padrões alimentares (Emocional, Restritiva, Sobrevivência, Desconectada), absolvição da culpa, identificação
- identidade: redefinição de sucesso, pertencimento, "a mulher que come chocolate numa terça e segue em paz"
- historia_consultorio: narrativa real do consultório, história de paciente (anonimizada)
- reflexao_collab: reflexões longas, posts em collab, conteúdo pessoal da Evelyn
- outro: não se encaixa nas categorias acima

Responda SOMENTE com JSON válido, sem texto adicional:
[{"n": 1, "editoria": "canetas_noticia"}, ...]`;

/**
 * Classifica posts sem editoria em batches de 25.
 * Atualiza o banco diretamente.
 * Retorna { classified, errors }
 */
async function classifyUnclassified(limit = 200) {
  const { rows } = await db.query(
    `SELECT id, post_id, description, post_type, duration_s
     FROM editorial_posts
     WHERE editoria IS NULL AND editoria_manual = FALSE
     ORDER BY published_at DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );

  if (rows.length === 0) return { classified: 0, errors: [] };

  const BATCH = 25;
  let classified = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const lines = batch.map((p, idx) => {
      const desc = (p.description || '').slice(0, 300).replace(/\n/g, ' ');
      return `${idx + 1}. tipo:${p.post_type || '?'} duração:${p.duration_s || 0}s | "${desc}"`;
    }).join('\n');

    try {
      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: 800,
        system: CLASSIFY_SYSTEM,
        messages: [{ role: 'user', content: `Classifique:\n${lines}` }],
      });

      const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      let results;
      try { results = JSON.parse(clean); }
      catch { const m = clean.match(/\[[\s\S]*\]/); if (m) results = JSON.parse(m[0]); }

      if (!Array.isArray(results)) throw new Error('Resposta inválida da IA');

      for (const r of results) {
        const idx = (r.n || 0) - 1;
        if (idx < 0 || idx >= batch.length) continue;
        const editoria = EDITORIAS.includes(r.editoria) ? r.editoria : 'outro';
        await db.query(
          `UPDATE editorial_posts SET editoria = $1, updated_at = NOW()
           WHERE id = $2 AND editoria_manual = FALSE`,
          [editoria, batch[idx].id]
        );
        classified++;
      }
    } catch (err) {
      errors.push(`Batch ${Math.floor(i / BATCH) + 1}: ${err.message}`);
    }
  }

  return { classified, errors };
}

// ── Analytics ───────────────────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

async function getAnalytics(account = 'nutrievelynliu') {
  // Todos os posts da conta com editoria classificada e reach > 0
  const { rows: posts } = await db.query(
    `SELECT id, post_id, description, post_type, published_at, date,
            permalink, editoria, reach, shares, follows, saves, comments,
            likes, views, editoria_manual
     FROM editorial_posts
     WHERE account_username = $1 AND reach > 0
     ORDER BY COALESCE(published_at, date::timestamptz) DESC NULLS LAST`,
    [account]
  );

  // Calcular taxas por post
  const withRates = posts.map(p => ({
    ...p,
    taxa_envio:      p.shares  / p.reach,
    taxa_seguidor:   p.follows / p.reach,
    taxa_salvamento: p.saves   / p.reach,
    taxa_comentario: p.comments / p.reach,
  }));

  // Agrupar por editoria
  const byEditoria = {};
  for (const p of withRates) {
    if (!p.editoria) continue;
    if (!byEditoria[p.editoria]) byEditoria[p.editoria] = [];
    byEditoria[p.editoria].push(p);
  }

  // Stats por editoria
  const editoriaStats = {};
  const reencarnacao = [];
  const alertasFadiga = [];

  for (const [ed, edPosts] of Object.entries(byEditoria)) {
    const medEnvio      = median(edPosts.map(p => p.taxa_envio));
    const medSeguidor   = median(edPosts.map(p => p.taxa_seguidor));
    const medSalvamento = median(edPosts.map(p => p.taxa_salvamento));
    const medComentario = median(edPosts.map(p => p.taxa_comentario));

    // Top posts por cada taxa (top 3)
    const topEnvio      = [...edPosts].sort((a, b) => b.taxa_envio - a.taxa_envio).slice(0, 3);
    const topSeguidor   = [...edPosts].sort((a, b) => b.taxa_seguidor - a.taxa_seguidor).slice(0, 3);
    const topSalvamento = [...edPosts].sort((a, b) => b.taxa_salvamento - a.taxa_salvamento).slice(0, 3);

    // Tendência 4 semanas (últimas 4 semanas, média das taxas)
    const agora = new Date();
    const tendencia = [];
    for (let w = 3; w >= 0; w--) {
      const semFim   = new Date(agora); semFim.setDate(agora.getDate() - w * 7);
      const semIni   = new Date(semFim); semIni.setDate(semFim.getDate() - 6);
      const semPosts = edPosts.filter(p => {
        const d = p.published_at ? new Date(p.published_at) : (p.date ? new Date(p.date) : null);
        return d && d >= semIni && d <= semFim;
      });
      tendencia.push({
        semana:          semIni.toISOString().slice(0, 10),
        posts:           semPosts.length,
        media_envio:     semPosts.length ? semPosts.reduce((s, p) => s + p.taxa_envio, 0) / semPosts.length : null,
        media_salvamento:semPosts.length ? semPosts.reduce((s, p) => s + p.taxa_salvamento, 0) / semPosts.length : null,
      });
    }

    editoriaStats[ed] = {
      posts_count:        edPosts.length,
      mediana_envio:      medEnvio,
      mediana_seguidor:   medSeguidor,
      mediana_salvamento: medSalvamento,
      mediana_comentario: medComentario,
      tendencia_4semanas: tendencia,
      top_envio:          topEnvio.map(briefPost),
      top_seguidor:       topSeguidor.map(briefPost),
      top_salvamento:     topSalvamento.map(briefPost),
    };

    // Fila de reencarnação: qualquer métrica >= 2x mediana
    for (const p of edPosts) {
      if (
        (medEnvio > 0      && p.taxa_envio      >= 2 * medEnvio)      ||
        (medSalvamento > 0 && p.taxa_salvamento >= 2 * medSalvamento) ||
        (medSeguidor > 0   && p.taxa_seguidor   >= 2 * medSeguidor)
      ) {
        reencarnacao.push({
          ...briefPost(p),
          editoria: ed,
          razao: buildRazao(p, medEnvio, medSeguidor, medSalvamento),
        });
      }
    }

    // Alerta fadiga: últimos 3 posts consecutivos todos ≤ 0.5x mediana (em alguma métrica chave)
    const ultimos3 = edPosts.slice(0, 3); // já ordenados por data DESC
    if (ultimos3.length === 3) {
      const fadiga = ultimos3.every(p =>
        (medEnvio > 0      && p.taxa_envio      <= 0.5 * medEnvio) &&
        (medSalvamento > 0 && p.taxa_salvamento <= 0.5 * medSalvamento)
      );
      if (fadiga) alertasFadiga.push(ed);
    }
  }

  // Top geral (todos posts, todas editorias)
  const topGeralEnvio      = [...withRates].sort((a, b) => b.taxa_envio - a.taxa_envio).slice(0, 5);
  const topGeralSeguidor   = [...withRates].sort((a, b) => b.taxa_seguidor - a.taxa_seguidor).slice(0, 5);
  const topGeralSalvamento = [...withRates].sort((a, b) => b.taxa_salvamento - a.taxa_salvamento).slice(0, 5);

  // Contagem de não classificados
  const { rows: [{ n: semClassificacao }] } = await db.query(
    `SELECT COUNT(*) AS n FROM editorial_posts
     WHERE account_username = $1 AND editoria IS NULL`,
    [account]
  );

  return {
    total_posts:        posts.length,
    sem_classificacao:  parseInt(semClassificacao, 10),
    por_editoria:       editoriaStats,
    fila_reencarnacao:  reencarnacao,
    alertas_fadiga:     alertasFadiga,
    top_geral: {
      envio:      topGeralEnvio.map(p => ({ ...briefPost(p), editoria: p.editoria })),
      seguidor:   topGeralSeguidor.map(p => ({ ...briefPost(p), editoria: p.editoria })),
      salvamento: topGeralSalvamento.map(p => ({ ...briefPost(p), editoria: p.editoria })),
    },
  };
}

function briefPost(p) {
  return {
    id:              p.id,
    post_id:         p.post_id,
    description:     (p.description || '').slice(0, 120),
    post_type:       p.post_type,
    published_at:    p.published_at || p.date,
    permalink:       p.permalink,
    reach:           p.reach,
    taxa_envio:      round4(p.taxa_envio),
    taxa_seguidor:   round4(p.taxa_seguidor),
    taxa_salvamento: round4(p.taxa_salvamento),
    taxa_comentario: round4(p.taxa_comentario),
  };
}

function round4(n) { return Math.round((n || 0) * 10000) / 10000; }

function buildRazao(p, medEnvio, medSeguidor, medSalvamento) {
  const parts = [];
  if (medEnvio > 0      && p.taxa_envio >= 2 * medEnvio)
    parts.push(`envios ${(p.taxa_envio / medEnvio).toFixed(1)}x mediana`);
  if (medSalvamento > 0 && p.taxa_salvamento >= 2 * medSalvamento)
    parts.push(`salvamentos ${(p.taxa_salvamento / medSalvamento).toFixed(1)}x mediana`);
  if (medSeguidor > 0   && p.taxa_seguidor >= 2 * medSeguidor)
    parts.push(`seguidores ${(p.taxa_seguidor / medSeguidor).toFixed(1)}x mediana`);
  return parts.join(', ');
}

// ── Mining — Banco de Mineração ─────────────────────────────────────────────

const MINING_TYPES = ['frase_de_seguidora', 'referencia_formato', 'noticia', 'ideia_solta'];

const LABEL_SYSTEM = `Você analisa itens do banco de mineração editorial da @nutrievelynliu (nutricionista comportamental — os 4 padrões, absolvição, identidade).

Para cada item, extraia:
- tema: assunto principal, máx 5 palavras
- dor: emoção ou dor da seguidora que o item evoca, máx 4 palavras
- editoria_provavel: canetas_noticia | tipologico_absolvicao | identidade | historia_consultorio | reflexao_collab | outro
- hook_potencial: true se o item pode virar hook de post (frase impactante, cena específica, dado surpreendente, situação reconhecível)

Responda SOMENTE JSON válido, sem nada antes ou depois:
[{"n":1,"tema":"...","dor":"...","editoria_provavel":"...","hook_potencial":false}]`;

/**
 * Normaliza texto para dedup: lowercase, trim, colapsa espaços/quebras.
 */
function normalizeContent(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Insere itens em lote, deduplica por conteúdo normalizado.
 * Retorna { inserted, duplicates, items (ids dos inseridos) }
 */
async function batchInsertMining({ items, type, source_url = null, expires_at = null }) {
  if (!MINING_TYPES.includes(type)) throw new Error(`tipo inválido: ${type}`);

  let inserted = 0;
  let duplicates = 0;
  const insertedIds = [];

  for (const raw of items) {
    const content = String(raw || '').trim();
    if (!content) continue;
    const norm = normalizeContent(content);

    // Checa dedup por conteúdo normalizado
    const { rows: existing } = await db.query(
      `SELECT id FROM editorial_mining_items WHERE lower(trim(regexp_replace(content,'\\s+',' ','g'))) = $1 LIMIT 1`,
      [norm]
    );
    if (existing.length > 0) { duplicates++; continue; }

    const { rows } = await db.query(
      `INSERT INTO editorial_mining_items (type, content, source_url, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [type, content, source_url || null, expires_at || null]
    );
    insertedIds.push(rows[0].id);
    inserted++;
  }

  return { inserted, duplicates, ids: insertedIds };
}

/**
 * Etiqueta itens sem tema/dor via LLM, em batches de 20.
 * Atualiza tema, dor, editoria_provavel, hook_potencial no banco.
 * Retorna { labeled, errors }
 */
async function labelUnlabeledMining(limit = 300) {
  const { rows } = await db.query(
    `SELECT id, type, content FROM editorial_mining_items
     WHERE tema IS NULL AND status = 'novo'
     ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  if (rows.length === 0) return { labeled: 0, errors: [] };

  const BATCH = 20;
  let labeled = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const lines = batch.map((r, idx) =>
      `${idx + 1}. [${r.type}] "${r.content.slice(0, 400)}"`
    ).join('\n');

    try {
      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: 1200,
        system: LABEL_SYSTEM,
        messages: [{ role: 'user', content: `Etiquete:\n${lines}` }],
      });

      const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      let results;
      try { results = JSON.parse(clean); }
      catch { const m = clean.match(/\[[\s\S]*\]/); if (m) results = JSON.parse(m[0]); }

      if (!Array.isArray(results)) throw new Error('Resposta inválida da IA');

      for (const r of results) {
        const idx = (r.n || 0) - 1;
        if (idx < 0 || idx >= batch.length) continue;
        const edProv = EDITORIAS.includes(r.editoria_provavel) ? r.editoria_provavel : 'outro';
        await db.query(
          `UPDATE editorial_mining_items
           SET tema = $1, dor = $2, editoria_provavel = $3, hook_potencial = $4
           WHERE id = $5`,
          [r.tema || null, r.dor || null, edProv, r.hook_potencial === true, batch[idx].id]
        );
        labeled++;
      }
    } catch (err) {
      errors.push(`Batch ${Math.floor(i / BATCH) + 1}: ${err.message}`);
    }
  }

  return { labeled, errors };
}

/**
 * Lista itens com filtros opcionais.
 */
async function listMiningItems({ type, status, editoria_provavel, hook_potencial, page = 1, limit = 60 } = {}) {
  const where = [];
  const params = [];

  if (type)              { params.push(type);              where.push(`type = $${params.length}`); }
  if (status)            { params.push(status);            where.push(`status = $${params.length}`); }
  if (editoria_provavel) { params.push(editoria_provavel); where.push(`editoria_provavel = $${params.length}`); }
  if (hook_potencial === 'true' || hook_potencial === true) where.push(`hook_potencial = TRUE`);

  const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const offset   = (Math.max(1, page) - 1) * limit;

  const [{ rows }, { rows: cnt }] = await Promise.all([
    db.query(
      `SELECT * FROM editorial_mining_items ${whereStr}
       ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) AS n FROM editorial_mining_items ${whereStr}`, params),
  ]);

  return { items: rows, total: parseInt(cnt[0].n, 10), page, limit };
}

// ── Phase 3 — Radar de Temas ────────────────────────────────────────────────

const RADAR_YEAR = new Date().getFullYear();
const RADAR_QUERIES_DEFAULT = [
  `semaglutida tirzepatida Brasil notícias ${RADAR_YEAR}`,
  `Anvisa medicamento emagrecimento aprovação ${RADAR_YEAR}`,
  'Cimed Prati EMS genérico semaglutida lançamento Brasil',
  'pesquisa obesidade comportamento alimentar mulher Brasil',
  'dieta tendência celebridade semana Brasil',
];

const RADAR_SYSTEM = `Você analisa temas para @nutrievelynliu, nutricionista comportamental (os 4 padrões, GLP-1, absolvição). Score de aderência = o tema permite à Evelyn dizer algo que SÓ a tese dela diz?

Responda SOMENTE com um objeto JSON, sem citações ou texto depois dele:
{ "tema": "...", "resumo": "...", "fonte_url": "...", "score_aderencia": 0, "score_justificativa": "...", "editoria_sugerida": "..." }

editoria_sugerida deve ser exatamente uma destas opções:
canetas_noticia, tipologico_absolvicao, identidade, historia_consultorio, reflexao_collab, outro`;

// Extrai texto de blocos type:'text' da resposta (ignora server_tool_use/results).
function extractRadarText(msg) {
  if (!msg || !Array.isArray(msg.content)) return '';
  return msg.content.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
}

// Extrai o primeiro objeto JSON completo, ignorando markdown, citações e texto
// adicional que ferramentas de busca podem anexar depois da resposta.
function parseFirstJsonObject(text) {
  const clean = String(text || '').replace(/^```(?:json)?\s*/i, '').trim();
  const start = clean.indexOf('{');
  if (start < 0) throw new Error(`JSON inválido: ${clean.slice(0, 120)}`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < clean.length; i++) {
    const char = clean[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return JSON.parse(clean.slice(start, i + 1));
    }
  }
  throw new Error(`JSON incompleto: ${clean.slice(0, 120)}`);
}

function normalizeRadarEditoria(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (EDITORIAS.includes(normalized)) return normalized;
  if (/caneta|medicamento|glp|noticia/.test(normalized)) return 'canetas_noticia';
  if (/tipolog|absolv|padrao/.test(normalized)) return 'tipologico_absolvicao';
  if (/identidade|pertencimento/.test(normalized)) return 'identidade';
  if (/consultorio|paciente|historia/.test(normalized)) return 'historia_consultorio';
  if (/reflex|collab|pessoal/.test(normalized)) return 'reflexao_collab';
  return 'outro';
}

// Processa UMA query: web search (GA) → fallback conhecimento → parse → insert.
// Web search é GA no endpoint padrão (messages.create), sem beta header.
async function runRadarQuery(query) {
  let text = '';
  let webErrMsg = null;

  // 1) Web search via endpoint GA (sem beta). Falha → registra motivo, cai pro fallback.
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: RADAR_SYSTEM,
      messages: [{ role: 'user', content: `Pesquise notícias recentes e analise: ${query}` }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    });
    text = extractRadarText(msg);
  } catch (webErr) {
    webErrMsg = webErr?.message || String(webErr);
    console.warn(`[radar] web search falhou ("${query}"): ${webErrMsg} — usando fallback`);
  }

  // 2) Fallback: conhecimento do modelo (sem web). Se ISSO falhar, propaga erro claro.
  if (!text) {
    try {
      const fallback = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: RADAR_SYSTEM,
        messages: [{ role: 'user', content: `Com base no seu conhecimento atual, analise o tema: ${query}` }],
      });
      text = extractRadarText(fallback);
    } catch (fbErr) {
      throw new Error(`[${MODEL}] web: ${webErrMsg || 'n/a'} | fallback: ${fbErr?.message || fbErr}`);
    }
  }

  if (!text) throw new Error(`sem texto na resposta${webErrMsg ? ` (web: ${webErrMsg})` : ''}`);

  const parsed = parseFirstJsonObject(text);

  const score = Math.max(0, Math.min(10, Number(parsed.score_aderencia) || 0));
  const status = score <= 5 ? 'descartado' : 'pendente';
  const editoria = normalizeRadarEditoria(parsed.editoria_sugerida);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 14);

  const { rows } = await db.query(
    `INSERT INTO editorial_temas_radar
       (tema, resumo, fonte_url, score_aderencia, score_justificativa, editoria_sugerida, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      parsed.tema || query,
      parsed.resumo || null,
      parsed.fonte_url || null,
      score,
      parsed.score_justificativa || null,
      editoria,
      status,
      expiresAt.toISOString(),
    ]
  );
  return rows[0];
}

// Roda em background, uma query por vez. O fluxo antigo disparava cinco buscas
// simultâneas e frequentemente esbarrava no limite de concorrência da API.
// Cada query continua independente: falha de uma não derruba as demais.
async function runRadar(customQueries = null) {
  const queries = customQueries && Array.isArray(customQueries) && customQueries.length > 0
    ? customQueries
    : RADAR_QUERIES_DEFAULT;

  const temas = [];
  const errors = [];
  for (const query of queries) {
    try {
      temas.push(await runRadarQuery(query));
    } catch (err) {
      errors.push({ query, error: err?.message || String(err) });
    }
  }

  return { temas, errors };
}

// ── Phase 4 — Pauta + Roteiros ──────────────────────────────────────────────

const SLOTS_PADRAO = [
  { dia: 'SEG', editoria: 'canetas_noticia',       formato: 'reel_medio',   metrica_alvo: 'seguidor' },
  { dia: 'QUA', editoria: 'tipologico_absolvicao', formato: 'carrossel',    metrica_alvo: 'salvamento' },
  { dia: 'SEX', editoria: 'identidade',            formato: 'reel_curto',   metrica_alvo: 'envio' },
  { dia: 'DOM', editoria: 'historia_consultorio',  formato: 'reel_longo',   metrica_alvo: 'comentario' },
];

async function gerarPauta(semanaId, { forcar = false } = {}) {
  // Check existing
  const { rows: existing } = await db.query(
    `SELECT * FROM editorial_pautas WHERE semana_id = $1 ORDER BY created_at ASC`,
    [semanaId]
  );
  if (existing.length > 0 && !forcar) return existing;
  if (existing.length > 0 && forcar) {
    await db.query(`DELETE FROM editorial_pautas WHERE semana_id = $1`, [semanaId]);
  }

  // Fetch context
  const [{ rows: temasAprovados }, { rows: reencarnacaoQueue }, { rows: miningHooks }, analytics] = await Promise.all([
    db.query(`SELECT tema, resumo, editoria_sugerida FROM editorial_temas_radar WHERE status = 'aprovado' ORDER BY score_aderencia DESC LIMIT 10`),
    db.query(`SELECT id, post_id, description, editoria FROM editorial_posts WHERE editoria IS NOT NULL ORDER BY (shares + saves) DESC LIMIT 3`),
    db.query(`SELECT content, tema, dor, editoria_provavel FROM editorial_mining_items WHERE hook_potencial = TRUE AND status = 'novo' ORDER BY created_at DESC LIMIT 5`),
    getAnalytics('nutrievelynliu').catch(() => ({ alertas_fadiga: [] })),
  ]);

  const ctx = JSON.stringify({
    temas_aprovados: temasAprovados,
    reencarnacao: reencarnacaoQueue.map(p => ({ post_id: p.post_id, editoria: p.editoria, desc: (p.description || '').slice(0, 120) })),
    mining_hooks: miningHooks,
    alertas_fadiga: analytics.alertas_fadiga || [],
    slots: SLOTS_PADRAO,
  }, null, 2);

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: `Você é o motor editorial de @nutrievelynliu. Dados os contextos abaixo, proponha 4 slots de pauta para a semana. Responda SOMENTE JSON array: [{dia, editoria, formato, frase_tese, metrica_alvo, fontes:[]}]`,
    messages: [{ role: 'user', content: `Contexto:\n${ctx}` }],
  });

  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let slots;
  try { slots = JSON.parse(clean); }
  catch { const m = clean.match(/\[[\s\S]*\]/); if (m) slots = JSON.parse(m[0]); else throw new Error('JSON inválido da IA'); }

  if (!Array.isArray(slots)) throw new Error('Resposta inválida da IA para pauta');

  const pautas = [];
  for (const slot of slots.slice(0, 4)) {
    const { rows } = await db.query(
      `INSERT INTO editorial_pautas (semana_id, slot_dia, editoria, formato, frase_tese, metrica_alvo, fontes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'proposto') RETURNING *`,
      [
        semanaId,
        slot.dia || null,
        slot.editoria || null,
        slot.formato || null,
        slot.frase_tese || null,
        slot.metrica_alvo || null,
        JSON.stringify(slot.fontes || []),
      ]
    );
    pautas.push(rows[0]);
  }

  return pautas;
}

const ROTEIRO_SYSTEM = `Você é o roteirista de @nutrievelynliu, nutricionista comportamental.

REGRAS ABSOLUTAS (RED FLAGS — presença = rejeitar):
- Proibido: compulsão, transtorno, TCA, bulimia, anorexia, Xkg (número + kg), antes/depois, calorias específicas
- "você" apenas antes de ação neutra

VOCABULÁRIO OBRIGATÓRIO (use ao menos 2):
- raiz, padrão, "os 4", emoção sem destino

ESTRUTURA:
- hook: 3 primeiras palavras NÃO podem servir para qualquer nutri
- absolvição: sempre terminar com variação de "não é falta de força de vontade, é padrão"
- CTA único: envio | comentário | salvamento | bio_quiz

Para carrossel: adicionar campo "slides" (array de 5-8 strings).

Gere 2 variações. Responda SOMENTE JSON array:
[{ variacao, hook, tensao, virada, frase_do_post, absolvicao, fechamento, slides? }]`;

async function gerarRoteiros(pautaId) {
  const { rows: pautas } = await db.query(
    `SELECT * FROM editorial_pautas WHERE id = $1`,
    [pautaId]
  );
  if (pautas.length === 0) throw new Error('Pauta não encontrada');
  const pauta = pautas[0];

  const { rows: miningHooks } = await db.query(
    `SELECT content, tema, dor FROM editorial_mining_items WHERE hook_potencial = TRUE AND status = 'novo' ORDER BY created_at DESC LIMIT 3`
  );

  const ctx = JSON.stringify({
    editoria: pauta.editoria,
    formato: pauta.formato,
    frase_tese: pauta.frase_tese,
    metrica_alvo: pauta.metrica_alvo,
    fontes: pauta.fontes,
    inspiracoes_mining: miningHooks,
  }, null, 2);

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: ROTEIRO_SYSTEM,
    messages: [{ role: 'user', content: `Pauta:\n${ctx}\n\nGere 2 variações de roteiro.` }],
  });

  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let variações;
  try { variações = JSON.parse(clean); }
  catch { const m = clean.match(/\[[\s\S]*\]/); if (m) variações = JSON.parse(m[0]); else throw new Error('JSON inválido'); }

  if (!Array.isArray(variações)) throw new Error('Resposta inválida da IA para roteiro');

  const roteiros = [];
  for (let i = 0; i < Math.min(variações.length, 2); i++) {
    const v = variações[i];
    const fullContent = JSON.stringify(v);
    const flags = validateRoteiro(fullContent);

    const { rows } = await db.query(
      `INSERT INTO editorial_roteiros
         (pauta_id, variacao, hook, tensao, virada, frase_do_post, absolvicao, fechamento, slides, full_content, flags, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'rascunho') RETURNING *`,
      [
        pautaId,
        i + 1,
        v.hook || null,
        v.tensao || null,
        v.virada || null,
        v.frase_do_post || null,
        v.absolvicao || null,
        v.fechamento || null,
        v.slides ? JSON.stringify(v.slides) : null,
        fullContent,
        JSON.stringify(flags),
      ]
    );
    roteiros.push({ ...rows[0], flags });
  }

  return roteiros;
}

function validateRoteiro(content) {
  const flags = [];
  const c = content || '';

  const redPatterns = [
    { re: /compuls[aã]o/i,                 regra: 'Proibido: compulsão' },
    { re: /transtorno/i,                   regra: 'Proibido: transtorno' },
    { re: /\btca\b/i,                      regra: 'Proibido: TCA' },
    { re: /bulimiia|bulimia/i,             regra: 'Proibido: bulimia' },
    { re: /anorexia/i,                     regra: 'Proibido: anorexia' },
    { re: /\d+\s*kg\b/i,                   regra: 'Proibido: Xkg específico' },
    { re: /antes\s*(e|\/|&)\s*depois/i,    regra: 'Proibido: antes/depois' },
    { re: /\d+\s*calorias?\b/i,            regra: 'Proibido: calorias específicas' },
  ];

  for (const { re, regra } of redPatterns) {
    const match = c.match(re);
    if (match) flags.push({ nivel: 'vermelho', regra, trecho: match[0] });
  }

  const lower = c.toLowerCase();
  const vocab = ['raiz', 'padrão', 'os 4', 'emoção sem destino'];
  if (!vocab.some(w => lower.includes(w))) {
    flags.push({ nivel: 'amarelo', regra: 'Vocabulário obrigatório ausente (raiz/padrão/os 4/emoção sem destino)', trecho: '' });
  }

  const vocêRe = /você\s+(é|está|sofre|tem |sente|come )/gi;
  const vocêMatches = c.match(vocêRe);
  if (vocêMatches) {
    for (const m of vocêMatches) {
      flags.push({ nivel: 'amarelo', regra: '"você" antes de estado (não de ação neutra)', trecho: m });
    }
  }

  if (flags.length === 0) flags.push({ nivel: 'verde', regra: 'Tudo ok', trecho: '' });

  return flags;
}

// ── Phase 5 — Semana gamificada ─────────────────────────────────────────────

function getMondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun,1=Mon,...
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

async function getSemanaAtual() {
  const monday = getMondayOf(new Date());
  const { rows } = await db.query(
    `SELECT * FROM editorial_semanas WHERE semana_inicio = $1`,
    [monday]
  );
  if (rows.length > 0) return rows[0];

  // semana_fim = domingo (segunda + 6 dias) — coluna é NOT NULL
  const sundayDate = new Date(monday);
  sundayDate.setDate(sundayDate.getDate() + 6);
  const sunday = sundayDate.toISOString().slice(0, 10);

  const { rows: inserted } = await db.query(
    `INSERT INTO editorial_semanas (semana_inicio, semana_fim, fase, estado)
     VALUES ($1, $2, 1, '{}') RETURNING *`,
    [monday, sunday]
  );
  return inserted[0];
}

async function getSemanaStatus(semanaId) {
  const { rows: semanas } = await db.query(
    `SELECT * FROM editorial_semanas WHERE id = $1`,
    [semanaId]
  );
  if (semanas.length === 0) throw new Error('Semana não encontrada');
  const semana = semanas[0];

  const { rows: pautas } = await db.query(
    `SELECT p.*, COUNT(r.id)::int AS roteiros_count
     FROM editorial_pautas p
     LEFT JOIN editorial_roteiros r ON r.pauta_id = p.id
     WHERE p.semana_id = $1
     GROUP BY p.id
     ORDER BY p.created_at ASC`,
    [semanaId]
  );

  const pautaIds = pautas.map(p => p.id);
  let roteiros = [];
  if (pautaIds.length > 0) {
    const result = await db.query(
      `SELECT * FROM editorial_roteiros
       WHERE pauta_id = ANY($1::int[])
       ORDER BY pauta_id, variacao ASC`,
      [pautaIds]
    );
    roteiros = result.rows;
  }
  const roteirosPorPauta = {};
  for (const roteiro of roteiros) {
    if (!roteirosPorPauta[roteiro.pauta_id]) roteirosPorPauta[roteiro.pauta_id] = [];
    roteirosPorPauta[roteiro.pauta_id].push(roteiro);
  }

  // Streak: consecutive semanas with fase=5 going back
  const { rows: semanasBack } = await db.query(
    `SELECT fase, estado FROM editorial_semanas
     WHERE semana_inicio <= $1
     ORDER BY semana_inicio DESC`,
    [semana.semana_inicio]
  );
  let streak = 0;
  for (const s of semanasBack) {
    if (s.fase >= 5 && s.estado?.fase5?.leitura_feita === true) streak++;
    else break;
  }

  const checklist = {
    radar_rodado:    pautas.length > 0 || semana.fase >= 2,
    pauta_gerada:    pautas.length >= 4,
    roteiros_ok:     pautas.every(p => p.roteiros_count > 0),
    aprovado:        semana.fase >= 4,
    publicado:       semana.estado?.fase5?.leitura_feita === true,
  };

  return {
    semana,
    pautas,
    roteiros_por_pauta: roteirosPorPauta,
    checklist,
    streak,
    placar: {
      no_alvo: semana.placar_posts_no_alvo || 0,
      total: semana.placar_posts_total || 0,
    },
  };
}

async function avancarFase(semanaId, dadosFase = {}) {
  const { rows } = await db.query(
    `UPDATE editorial_semanas
     SET fase = LEAST(fase + 1, 5),
         estado = estado || $1::jsonb,
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [JSON.stringify(dadosFase), semanaId]
  );
  if (rows.length === 0) throw new Error('Semana não encontrada');

  if (dadosFase?.fase5?.leitura_feita === true) {
    const noAlvo = Array.isArray(dadosFase.fase5.no_alvo) ? dadosFase.fase5.no_alvo.length : 0;
    await db.query(
      `UPDATE editorial_semanas
       SET placar_posts_no_alvo = $1,
           placar_posts_total = (SELECT COUNT(*) FROM editorial_pautas WHERE semana_id = $2),
           updated_at = NOW()
       WHERE id = $2`,
      [noAlvo, semanaId]
    );
  }

  return rows[0];
}

async function salvarEstadoSemana(semanaId, dadosFase = {}) {
  const { rows } = await db.query(
    `UPDATE editorial_semanas
     SET estado = estado || $1::jsonb,
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [JSON.stringify(dadosFase), semanaId]
  );
  if (rows.length === 0) throw new Error('Semana não encontrada');
  return rows[0];
}

// ── Phase 6 — Seed ───────────────────────────────────────────────────────────

async function seedEditorial() {
  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*) AS n FROM editorial_posts`);
  if (parseInt(n, 10) > 0) return { seeded: false, reason: 'já tem dados' };

  const now = new Date();
  const d = (daysAgo) => { const x = new Date(now); x.setDate(x.getDate() - daysAgo); return x.toISOString(); };

  // 4 posts fictícios
  const posts = [
    { post_id: 'seed_001', description: 'Você conhece o Padrão Emocional? A raiz do comer emocional não é fraqueza — é emoção sem destino. #os4', editoria: 'tipologico_absolvicao', post_type: 'REEL', views: 12000, reach: 8000, likes: 430, shares: 210, follows: 55, comments: 88, saves: 320, published_at: d(30) },
    { post_id: 'seed_002', description: 'Anvisa aprovou mais uma opção no Brasil. O que isso muda pra quem já usa GLP-1? Minha análise como nutri.', editoria: 'canetas_noticia', post_type: 'REEL', views: 25000, reach: 18000, likes: 890, shares: 540, follows: 210, comments: 145, saves: 670, published_at: d(20) },
    { post_id: 'seed_003', description: 'A paciente me disse: "eu começo bem mas sempre saboto". Isso tem nome. Tem padrão. Não é falta de força de vontade.', editoria: 'historia_consultorio', post_type: 'CAROUSEL', views: 9000, reach: 6500, likes: 310, shares: 95, follows: 40, comments: 62, saves: 480, published_at: d(14) },
    { post_id: 'seed_004', description: 'Sucesso não é a dieta perfeita. É a mulher que come chocolate numa terça e segue em paz. Identidade > disciplina.', editoria: 'identidade', post_type: 'REEL', views: 31000, reach: 22000, likes: 1200, shares: 780, follows: 340, comments: 210, saves: 890, published_at: d(7) },
  ];

  for (const p of posts) {
    await db.query(
      `INSERT INTO editorial_posts
         (post_id, account_username, description, post_type, published_at, editoria, editoria_manual,
          views, reach, likes, shares, follows, comments, saves)
       VALUES ($1,'nutrievelynliu',$2,$3,$4,$5,TRUE,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (post_id) DO NOTHING`,
      [p.post_id, p.description, p.post_type, p.published_at, p.editoria, p.views, p.reach, p.likes, p.shares, p.follows, p.comments, p.saves]
    );
  }

  // 10 mining items
  const miningItems = [
    'Eu como escondida porque tenho vergonha do que os outros vão pensar',
    'Toda vez que fico ansiosa a primeira coisa que faço é abrir a geladeira',
    'Sigo a dieta perfeita a semana inteira e no final de semana perco tudo',
    'Minha nutricionista só me dá lista de coisas que não posso comer',
    'Sinto que meu corpo me traiu quando não emagreço mesmo fazendo tudo certo',
    'A semaglutida foi a primeira coisa que funcionou mas tenho medo de parar',
    'Preciso estar com fome REAL pra comer mas nunca sei quando isso é',
    'Quando estou triste só um docinho resolve — e depois vem a culpa',
    'Os 4 padrões mudaram como eu me vejo, finalmente faz sentido',
    'Minha raiz é emocional, aprendi isso com você e agora consigo identificar',
  ];

  for (const content of miningItems) {
    await db.query(
      `INSERT INTO editorial_mining_items (type, content, hook_potencial, status)
       VALUES ('frase_de_seguidora', $1, TRUE, 'novo')
       ON CONFLICT DO NOTHING`,
      [content]
    );
  }

  // 2 temas radar aprovados
  const temas = [
    { tema: 'Tirzepatida aprovada no Brasil', resumo: 'Anvisa aprova tirzepatida para obesidade — oportunidade de posicionamento de autoridade com tese comportamental.', score_aderencia: 9, editoria_sugerida: 'canetas_noticia', status: 'aprovado' },
    { tema: 'Trend: "por que eu como quando não tenho fome"', resumo: 'Busca crescente no Google BR — abre direto para os 4 padrões e emoção sem destino.', score_aderencia: 10, editoria_sugerida: 'tipologico_absolvicao', status: 'aprovado' },
  ];

  for (const t of temas) {
    const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 14);
    await db.query(
      `INSERT INTO editorial_temas_radar (tema, resumo, score_aderencia, editoria_sugerida, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [t.tema, t.resumo, t.score_aderencia, t.editoria_sugerida, t.status, expiresAt.toISOString()]
    );
  }

  return { seeded: true };
}

module.exports = {
  EDITORIAS,
  MINING_TYPES,
  csvToObjects,
  upsertPosts,
  classifyUnclassified,
  getAnalytics,
  batchInsertMining,
  labelUnlabeledMining,
  listMiningItems,
  RADAR_QUERIES_DEFAULT,
  runRadar,
  SLOTS_PADRAO,
  gerarPauta,
  gerarRoteiros,
  validateRoteiro,
  getSemanaAtual,
  getSemanaStatus,
  avancarFase,
  salvarEstadoSemana,
  seedEditorial,
};

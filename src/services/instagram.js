// Integração com o Instagram via Meta Graph API (conta Instagram Business/Creator
// conectada a uma Página do Facebook). Busca perfil + mídias recentes com métricas
// de performance, de forma tolerante a versões/permissões da API.
//
// Configuração (.env):
//   IG_USER_ID            → ID da conta Instagram Business (numérico)
//   INSTAGRAM_ACCESS_TOKEN→ token com instagram_basic + instagram_manage_insights
//                           (cai para META_ADS_ACCESS_TOKEN se não definido)

const IG_API = 'https://graph.facebook.com/v20.0';

function igConfig() {
  return {
    token: process.env.INSTAGRAM_ACCESS_TOKEN || process.env.META_ADS_ACCESS_TOKEN || null,
    userId: process.env.IG_USER_ID || process.env.INSTAGRAM_BUSINESS_ID || null,
  };
}

// período ('week' | 'month' | 'year') → janela de datas. Default: month.
function computeDateRange(period) {
  const p = ['week', 'month', 'year'].includes(period) ? period : 'month';
  const until = new Date();
  const since = new Date(until);
  if (p === 'week') since.setDate(since.getDate() - 7);
  else if (p === 'year') since.setFullYear(since.getFullYear() - 1);
  else since.setMonth(since.getMonth() - 1);
  return { period: p, sinceMs: since.getTime(), untilMs: until.getTime() };
}

// Normaliza a lista de /media, filtra pela janela e ordena por engajamento (desc).
// Função pura — testável sem rede.
function shapePosts(mediaList, range) {
  const posts = (Array.isArray(mediaList) ? mediaList : []).map(m => {
    const ins = {};
    if (m.insights && Array.isArray(m.insights.data))
      m.insights.data.forEach(d => { ins[d.name] = (d.values && d.values[0] ? d.values[0].value : 0); });

    const likes = Number(m.like_count) || 0;
    const comments = Number(m.comments_count) || 0;
    const reach = Number.isFinite(ins.reach) ? ins.reach : null;
    const saved = Number.isFinite(ins.saved) ? ins.saved : null;
    const shares = Number.isFinite(ins.shares) ? ins.shares : null;
    const interactions = Number.isFinite(ins.total_interactions)
      ? ins.total_interactions
      : likes + comments + (saved || 0) + (shares || 0);

    return {
      id: m.id,
      type: m.media_product_type || m.media_type || 'POST',
      caption: (m.caption || '').replace(/\s+/g, ' ').trim().slice(0, 280),
      timestamp: m.timestamp || null,
      permalink: m.permalink || null,
      thumbnail: m.thumbnail_url || m.media_url || null,
      likes, comments, reach, saved, shares, interactions,
      engagementRate: reach ? Number(((interactions / reach) * 100).toFixed(1)) : null,
    };
  });

  const inRange = range
    ? posts.filter(p => {
        const t = p.timestamp ? new Date(p.timestamp).getTime() : NaN;
        return Number.isFinite(t) && t >= range.sinceMs && t <= range.untilMs;
      })
    : posts;

  inRange.sort((a, b) => b.interactions - a.interactions);
  return inRange;
}

async function fetchGraph(pathWithQuery) {
  const resp = await fetch(IG_API + pathWithQuery);
  const data = await resp.json();
  if (data && data.error) {
    const err = new Error(data.error.message || 'Erro na Graph API do Instagram');
    err.fbError = data.error;
    throw err;
  }
  return data;
}

// Busca a performance do Instagram para o período. Sempre retorna um objeto
// válido (nunca lança) — erros viram { configured, error } para a UI tratar.
async function getInstagramPerformance(period = 'month') {
  const { token, userId } = igConfig();
  const range = computeDateRange(period);

  if (!token || !userId) {
    return {
      configured: false,
      period: range.period,
      message: 'Instagram não configurado. Defina IG_USER_ID e INSTAGRAM_ACCESS_TOKEN (token com permissão instagram_manage_insights).',
      account: null, totals: null, posts: [],
    };
  }

  try {
    const profile = await fetchGraph(
      `/${userId}?fields=username,followers_count,follows_count,media_count,profile_picture_url&access_token=${token}`
    );

    // Tenta com insights aninhados; se a permissão/versão não permitir, cai para campos básicos.
    const withInsights = 'id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count,insights.metric(reach,saved,shares,total_interactions)';
    const basic = 'id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count';
    let media;
    try {
      media = await fetchGraph(`/${userId}/media?fields=${encodeURIComponent(withInsights)}&limit=50&access_token=${token}`);
    } catch {
      media = await fetchGraph(`/${userId}/media?fields=${encodeURIComponent(basic)}&limit=50&access_token=${token}`);
    }

    const posts = shapePosts(media.data, range);
    const totals = posts.reduce(
      (a, p) => ({ posts: a.posts + 1, reach: a.reach + (p.reach || 0), interactions: a.interactions + p.interactions }),
      { posts: 0, reach: 0, interactions: 0 }
    );

    return {
      configured: true,
      period: range.period,
      account: {
        username: profile.username || null,
        followers: profile.followers_count ?? null,
        following: profile.follows_count ?? null,
        mediaCount: profile.media_count ?? null,
        avatar: profile.profile_picture_url || null,
      },
      totals,
      posts,
    };
  } catch (e) {
    return {
      configured: true,
      period: range.period,
      error: e.fbError ? `${e.message} (Graph API)` : e.message,
      account: null, totals: null, posts: [],
    };
  }
}

module.exports = { getInstagramPerformance, shapePosts, computeDateRange };

// ── fix #1: escape HTML para evitar XSS com conteúdo gerado por IA ──
function safeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>');
}

// Carrossel é guardado como JSON estruturado ({slides:[{role,text,photo,bg}],legenda}).
// Renderiza de forma legível (não o JSON cru); qualquer outro conteúdo vira texto escapado.
function renderCardContentHtml(content) {
  try {
    const d = JSON.parse(content);
    if (d && Array.isArray(d.slides)) {
      const slidesHtml = d.slides.map((s, i) => {
        // índice apenas para leitura (não é rótulo do slide); título só se houver
        const tags = [s.title ? `“${s.title}”` : null, s.photo ? 'foto' : null, s.bg ? `${s.bg}` : null, s.signature ? 'assinatura' : null].filter(Boolean).join(' · ');
        return `<div style="margin-bottom:12px">
          <div style="font-size:.68rem;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase">${i + 1}${tags ? ` · ${safeHtml(tags)}` : ''}</div>
          <div>${safeHtml(s.text)}</div>
          ${s.signature ? `<div style="font-style:italic;color:var(--muted);font-size:.85rem;margin-top:2px">${safeHtml(s.signature)}</div>` : ''}
        </div>`;
      }).join('');
      const leg = d.legenda
        ? `<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--bege-dark)">
             <div style="font-size:.68rem;letter-spacing:1.5px;color:var(--muted)">LEGENDA</div>
             <div>${safeHtml(d.legenda)}</div>
           </div>` : '';
      return slidesHtml + leg;
    }
  } catch {}
  return safeHtml(content);
}

// ── State ──────────────────────────────────────────────
const state = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
};

// ── API ────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Respostas não-JSON (ex.: "upstream error" / 502/504 do proxy quando a
  // requisição demora demais) não devem virar "Unexpected token..." crípticos.
  let json;
  try {
    json = await res.json();
  } catch {
    if ([502, 503, 504].includes(res.status))
      throw new Error('O servidor demorou demais (tempo limite do proxy). Tente novamente.');
    throw new Error(`Resposta inválida do servidor (HTTP ${res.status}).`);
  }
  if (!json.success) throw new Error(json.error || 'Erro desconhecido');
  return json.data;
}

// ── Toast ──────────────────────────────────────────────
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = type;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3500);
}

// ── Auth ───────────────────────────────────────────────
async function login(email, password) {
  const data = await api('POST', '/auth/login', { email, password });
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('token', data.token);
  localStorage.setItem('user', JSON.stringify(data.user));
  renderApp();
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  renderApp();
}

// ── Role helpers ───────────────────────────────────────
// 'calendario' ocultado (fora de uso). Mantido em pages{} caso volte.
const ROLE_MENUS = {
  admin:  ['gerador','anuncios','repurposing','edicao','mercado','insights','editorial','admin'],
  evelyn: ['gerador','anuncios','repurposing','edicao','mercado','insights','editorial'],
  editor: ['gerador','anuncios','repurposing','edicao','mercado','insights','editorial'],
  nutri:  ['gerador','repurposing','edicao'],
};

// Ícones de linha (SVG) monocromáticos — herdam a cor do texto (currentColor)
const SVG = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const MENU_LABELS = {
  calendario:  { icon: SVG('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'), label: 'Calendário' },
  gerador:     { icon: SVG('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'), label: 'Gerador' },
  anuncios:    { icon: SVG('<path d="M3 11 21 6v12L3 13z"/><path d="M11.5 16.7a3 3 0 1 1-5.7-1.6"/>'), label: 'Anúncios' },
  repurposing: { icon: SVG('<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'), label: 'Repurposing' },
  edicao:      { icon: SVG('<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 3v18M17 3v18M2 12h20M2 7.5h5M2 16.5h5M17 7.5h5M17 16.5h5"/>'), label: 'Edição' },
  mercado:     { icon: SVG('<path d="M18 20V10M12 20V4M6 20v-6"/>'), label: 'Mercado' },
  insights:    { icon: SVG('<path d="M9 18h6M10 22h4"/><path d="M15.1 14c.2-1 .7-1.8 1.4-2.5A4.65 4.65 0 0 0 18 8 6 6 0 1 0 6.5 11.5c.7.7 1.2 1.5 1.4 2.5"/>'), label: 'Insights' },
  editorial:   { icon: SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'), label: 'Editorial' },
  admin:       { icon: SVG('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'), label: 'Admin' },
};

function canAccess(page) {
  if (!state.user) return false;
  return ROLE_MENUS[state.user.role]?.includes(page) ?? false;
}

// ── Router ─────────────────────────────────────────────
let currentPage = 'calendario';

function navigate(page) {
  if (!canAccess(page)) {
    page = ROLE_MENUS[state.user?.role]?.[0] || 'gerador';
  }
  currentPage = page;
  renderPage();
  document.querySelectorAll('nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.page === page);
  });
}

// ── Render ─────────────────────────────────────────────
function renderApp() {
  const root = document.getElementById('root');
  if (!state.token || !state.user) {
    root.innerHTML = renderLoginScreen();
    document.getElementById('login-form').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        await login(e.target.email.value, e.target.password.value);
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
    return;
  }

  const allowedPages = ROLE_MENUS[state.user.role] || [];
  const menuItems = allowedPages.map(p => {
    const m = MENU_LABELS[p];
    return `<li><a href="#" data-page="${p}"><span class="icon">${m.icon}</span>${m.label}</a></li>`;
  }).join('');

  root.innerHTML = `
    <div id="app">
      <header id="topbar">
        <button id="nav-toggle" aria-label="Menu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
        </button>
        <div class="topbar-logo">Table<span>Clinic</span></div>
      </header>
      <div id="nav-backdrop"></div>
      <nav id="sidebar">
        <div class="logo">Table<span>Clinic</span></div>
        <ul>${menuItems}</ul>
        <div class="user-info">
          <strong>${state.user.name}</strong>
          ${state.user.role}${state.user.nutri_name ? ' · ' + state.user.nutri_name : ''}
          <br><a href="#" id="logout-btn" style="color:rgba(248,244,238,.5);font-size:.75rem;margin-top:4px;display:inline-block">Sair</a>
        </div>
      </nav>
      <main id="content"></main>
    </div>
    <div id="toast"></div>
  `;

  // Drawer mobile: abre/fecha o sidebar
  const closeNav = () => document.getElementById('app')?.classList.remove('nav-open');
  document.getElementById('nav-toggle')?.addEventListener('click', () => {
    document.getElementById('app')?.classList.toggle('nav-open');
  });
  document.getElementById('nav-backdrop')?.addEventListener('click', closeNav);

  document.querySelectorAll('nav a[data-page]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); navigate(a.dataset.page); closeNav(); });
  });

  document.getElementById('logout-btn').addEventListener('click', e => { e.preventDefault(); logout(); });

  navigate(allowedPages[0]);
}

function renderPage() {
  const content = document.getElementById('content');
  const pages = { calendario, gerador, anuncios, repurposing, edicao, mercado, insights, editorial, admin };
  if (pages[currentPage]) pages[currentPage](content);
}

// ── Login ──────────────────────────────────────────────
function renderLoginScreen() {
  return `
    <div id="login-screen">
      <div class="login-card">
        <h1>TableClinic</h1>
        <p class="subtitle">Growth Hub — acesso restrito</p>
        <form id="login-form">
          <div class="form-group">
            <label>Email</label>
            <input type="email" name="email" placeholder="seu@email.com.br" required>
          </div>
          <div class="form-group">
            <label>Senha</label>
            <input type="password" name="password" placeholder="••••••••" required>
          </div>
          <button type="submit" class="btn btn-primary btn-full" style="margin-top:8px">Entrar</button>
        </form>
      </div>
    </div>
  `;
}

// ── Helpers ────────────────────────────────────────────
function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function badgeStatus(s) { return `<span class="badge badge-status-${s}">${s}</span>`; }
function badgePilar(p)  { return `<span class="badge badge-pilar-${p}">${p}</span>`; }
function badgeFormat(f) { return `<span class="badge badge-format">${f.replace('_',' ')}</span>`; }

function openModal(html) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">${html}</div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close')?.addEventListener('click', () => overlay.remove());
  return overlay;
}

// ── Pages ──────────────────────────────────────────────

async function calendario(el) {
  let view = 'month';
  let currentDate = new Date();

  el.innerHTML = `
    <div class="page-header">
      <h1>Calendário Editorial</h1>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline btn-sm" id="btn-week">Semana</button>
        <button class="btn btn-primary btn-sm" id="btn-month">Mês</button>
        <button class="btn btn-accent btn-sm" id="btn-new-card">+ Novo Card</button>
      </div>
    </div>
    <div class="filters">
      <select id="f-format"><option value="">Todos formatos</option>
        <option value="reel_curto">Reel Curto</option><option value="reel_medio">Reel Médio</option>
        <option value="reel_longo">Reel Longo</option><option value="carrossel">Carrossel</option>
        <option value="carrossel_video">Carrossel Vídeo</option>
      </select>
      <select id="f-pilar"><option value="">Todos pilares</option>
        <option value="tese">Tese</option><option value="ciencia">Ciência</option>
        <option value="provocacao">Provocação</option><option value="consultorio">Consultório</option>
      </select>
      <select id="f-status"><option value="">Todos status</option>
        <option value="ideia">Ideia</option><option value="roteiro">Roteiro</option>
        <option value="gravado">Gravado</option><option value="edicao">Edição</option>
        <option value="programado">Programado</option><option value="publicado">Publicado</option>
      </select>
    </div>
    <div id="cal-container"></div>
  `;

  async function load() {
    const format = document.getElementById('f-format').value;
    const pilar = document.getElementById('f-pilar').value;
    const status = document.getElementById('f-status').value;

    let cards = [];
    if (view === 'month') {
      cards = await api('GET', `/cards/month?year=${currentDate.getFullYear()}&month=${currentDate.getMonth()+1}${format?'&format='+format:''}${pilar?'&pilar='+pilar:''}${status?'&status='+status:''}`);
    } else {
      cards = await api('GET', `/cards/week?date=${currentDate.toISOString()}${format?'&format='+format:''}${pilar?'&pilar='+pilar:''}${status?'&status='+status:''}`);
    }
    renderCalendar(cards);
  }

  function renderCalendar(cards) {
    const container = document.getElementById('cal-container');
    if (view === 'month') {
      container.innerHTML = renderMonth(currentDate, cards);
    } else {
      container.innerHTML = renderWeek(currentDate, cards);
    }
    container.querySelectorAll('.cal-card').forEach(c => {
      c.addEventListener('click', () => openCardDetail(cards.find(x => x.id == c.dataset.id)));
    });
  }

  function renderMonth(date, cards) {
    const y = date.getFullYear(), m = date.getMonth();
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m+1, 0).getDate();
    const today = new Date();

    let html = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <button class="btn btn-sm btn-outline" id="prev-month">‹</button>
        <span style="font-family:'Cormorant Garamond',serif;font-size:1.2rem">${date.toLocaleDateString('pt-BR',{month:'long',year:'numeric'})}</span>
        <button class="btn btn-sm btn-outline" id="next-month">›</button>
      </div>
      <div class="cal-scroll"><div class="calendar-grid">
        ${['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].map(d=>`<div class="cal-header">${d}</div>`).join('')}
    `;

    const offset = first === 0 ? 6 : first - 1; // start on monday
    for (let i = 0; i < (first || 7); i++) html += `<div class="cal-day other-month"></div>`;

    for (let d = 1; d <= days; d++) {
      const isToday = today.getFullYear()===y && today.getMonth()===m && today.getDate()===d;
      const dayCards = cards.filter(c => c.publish_date && new Date(c.publish_date).getDate()===d &&
        new Date(c.publish_date).getMonth()===m && new Date(c.publish_date).getFullYear()===y);
      html += `<div class="cal-day${isToday?' today':''}">
        <div class="day-num">${d}</div>
        ${dayCards.map(c=>`<div class="cal-card pilar-${c.pilar}" data-id="${c.id}" title="${safeHtml(c.title)}">${safeHtml(c.title)}</div>`).join('')}
      </div>`;
    }
    html += '</div></div>';
    return html;
  }

  function renderWeek(date, cards) {
    const day = date.getDay();
    const mon = new Date(date); mon.setDate(date.getDate() - day + 1);
    const days = Array.from({length:7}, (_,i) => { const d=new Date(mon); d.setDate(mon.getDate()+i); return d; });

    const today = new Date();
    let html = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <button class="btn btn-sm btn-outline" id="prev-week">‹</button>
        <span style="font-family:'Cormorant Garamond',serif;font-size:1.1rem">${days[0].toLocaleDateString('pt-BR',{day:'2-digit',month:'short'})} – ${days[6].toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'})}</span>
        <button class="btn btn-sm btn-outline" id="next-week">›</button>
      </div>
      <div class="cal-scroll"><div class="week-grid">
    `;

    days.forEach(d => {
      const isToday = d.toDateString() === today.toDateString();
      const dayCards = cards.filter(c => c.publish_date && new Date(c.publish_date).toDateString()===d.toDateString());
      html += `
        <div class="week-day">
          <div class="week-day-header${isToday?' style="background:var(--terracota)"':''}">${d.toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit'})}</div>
          <div style="padding:8px;background:white;border:1px solid var(--bege-dark);min-height:160px">
            ${dayCards.map(c=>`<div class="cal-card pilar-${c.pilar}" data-id="${c.id}">${safeHtml(c.title)}</div>`).join('')}
          </div>
        </div>
      `;
    });
    html += '</div></div>';
    return html;
  }

  el.addEventListener('click', e => {
    if (e.target.id==='btn-month') { view='month'; load(); }
    if (e.target.id==='btn-week')  { view='week'; load(); }
    if (e.target.id==='prev-month') { currentDate=new Date(currentDate.getFullYear(),currentDate.getMonth()-1,1); load(); }
    if (e.target.id==='next-month') { currentDate=new Date(currentDate.getFullYear(),currentDate.getMonth()+1,1); load(); }
    if (e.target.id==='prev-week')  { currentDate.setDate(currentDate.getDate()-7); load(); }
    if (e.target.id==='next-week')  { currentDate.setDate(currentDate.getDate()+7); load(); }
    if (e.target.id==='btn-new-card') openNewCardModal(load);
  });

  ['f-format','f-pilar','f-status'].forEach(id => {
    el.querySelector('#'+id)?.addEventListener('change', load);
  });

  await load();
}

function openCardDetail(card) {
  const overlay = openModal(`
    <button class="modal-close">×</button>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      ${badgePilar(card.pilar)} ${badgeFormat(card.format)} ${badgeStatus(card.status)}
      ${card.generated_by_ai ? '<span class="badge" style="background:#f0e8ff;color:#5a2d9a">IA</span>' : ''}
    </div>
    <h2>${safeHtml(card.title)}</h2>
    <p style="color:var(--muted);font-size:.85rem;margin-bottom:16px">
      Responsável: ${card.responsible_name || '—'} · Publicação: ${formatDate(card.publish_date)}
    </p>
    ${card.drive_link ? `<p style="margin-bottom:12px"><a href="${card.drive_link}" target="_blank" style="color:var(--terracota)">Drive</a></p>` : ''}
    ${card.content ? `<div class="ai-output">${renderCardContentHtml(card.content)}</div>` : '<p style="color:var(--muted)">Sem roteiro ainda.</p>'}
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;align-items:center">
      <select id="status-select" style="padding:8px;border:1.5px solid var(--bege-dark);border-radius:6px;font-family:Jost,sans-serif">
        ${['ideia','roteiro','gravado','edicao','programado','publicado'].map(s=>`<option value="${s}"${s===card.status?' selected':''}>${s}</option>`).join('')}
      </select>
      <button class="btn btn-primary btn-sm" id="save-status">Atualizar status</button>
      ${['carrossel','carrossel_video'].includes(card.format) && card.content
        ? `<button class="btn btn-accent btn-sm" id="gen-carousel-btn">Gerar slides PNG</button>`
        : ''}
    </div>
    <div id="carousel-result" style="margin-top:12px"></div>
  `);

  overlay.querySelector('#save-status').addEventListener('click', async () => {
    try {
      const status = overlay.querySelector('#status-select').value;
      await api('PUT', `/cards/${card.id}/status`, { status });
      toast('Status atualizado');
      overlay.remove();
    } catch (e) { toast(e.message, 'error'); }
  });

  overlay.querySelector('#gen-carousel-btn')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('#gen-carousel-btn');
    const resultEl = overlay.querySelector('#carousel-result');
    btn.disabled = true;
    btn.textContent = 'Gerando slides...';
    resultEl.innerHTML = '<div class="loading"><div class="spinner"></div> Renderizando slides via Puppeteer...</div>';
    try {
      const data = await api('POST', `/cards/${card.id}/carousel`);
      resultEl.innerHTML = `
        <div style="background:var(--bege);border-radius:8px;padding:14px;display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.9rem"><strong>${data.slides} slides</strong> gerados (1080×1080px, 2×)</span>
          <a href="${encodeURI(data.download_url)}" download class="btn btn-accent btn-sm">Baixar ZIP</a>
        </div>
      `;
      toast(`${data.slides} slides prontos!`);
    } catch (e) {
      resultEl.innerHTML = `<p style="color:#c0392b;font-size:.85rem">Erro: ${safeHtml(e.message)}</p>`;
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Gerar slides PNG';
    }
  });
}

function openNewCardModal(onSave) {
  const overlay = openModal(`
    <button class="modal-close">×</button>
    <h2>Novo Card</h2>
    <form id="new-card-form">
      <div class="form-group"><label>Título</label><input name="title" required></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group"><label>Pilar</label>
          <select name="pilar"><option value="tese">Tese</option><option value="ciencia">Ciência</option><option value="provocacao">Provocação</option><option value="consultorio">Consultório</option></select>
        </div>
        <div class="form-group"><label>Formato</label>
          <select name="format"><option value="reel_curto">Reel Curto</option><option value="reel_medio">Reel Médio</option><option value="reel_longo">Reel Longo</option><option value="carrossel">Carrossel</option><option value="carrossel_video">Carrossel Vídeo</option></select>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group"><label>Data de publicação</label><input type="datetime-local" name="publish_date"></div>
        <div class="form-group"><label>Status</label>
          <select name="status"><option value="ideia">Ideia</option><option value="roteiro">Roteiro</option><option value="gravado">Gravado</option></select>
        </div>
      </div>
      <div class="form-group"><label>Link Drive</label><input name="drive_link" placeholder="https://..."></div>
      <div class="form-group"><label>Roteiro / Notas</label><textarea name="content" rows="4"></textarea></div>
      <button type="submit" class="btn btn-primary btn-full">Salvar Card</button>
    </form>
  `);

  overlay.querySelector('#new-card-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    try {
      await api('POST', '/cards', body);
      toast('Card criado!');
      overlay.remove();
      onSave?.();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ── Gerador ────────────────────────────────────────────
async function gerador(el) {
  el.innerHTML = `
    <div class="page-header"><h1>Gerador de Conteúdo</h1></div>
    <div class="card" style="max-width:680px">
      <form id="gen-form">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group"><label>Formato</label>
            <select name="format" id="gen-format">
              <option value="reel_curto">Reel Curto (até 30s)</option>
              <option value="reel_medio">Reel Médio (1-1:30)</option>
              <option value="reel_longo">Reel Longo (até 64s)</option>
              <option value="carrossel">Carrossel</option>
              <option value="carrossel_video">Carrossel Vídeo</option>
            </select>
          </div>
          <div class="form-group"><label>Pilar</label>
            <select name="pilar">
              <option value="tese">Tese</option>
              <option value="ciencia">Ciência Acessível</option>
              <option value="provocacao">Provocação</option>
              <option value="consultorio">Consultório</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Briefing (descreva a ideia, tema ou gatilho)</label>
          <textarea name="briefing" id="gen-briefing" rows="5" placeholder="Ex: A relação entre privação de sono e compulsão alimentar à noite..." required></textarea>
        </div>

        <!-- Campos extras para carrossel — visíveis apenas quando formato é carrossel -->
        <div id="carousel-extras" style="display:none">
          <div style="background:var(--bege);border-radius:8px;padding:14px;margin-bottom:14px">
            <p style="font-size:.8rem;font-weight:500;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:10px">Opções de Carrossel</p>

            <div class="form-group" style="margin-bottom:10px">
              <label style="font-size:.85rem">Modo</label>
              <div style="display:flex;gap:8px;margin-top:6px">
                <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer">
                  <input type="radio" name="carousel_mode" value="ai" checked> Gerar roteiro com IA e depois criar PNG
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer">
                  <input type="radio" name="carousel_mode" value="direct"> Já tenho o conteúdo — a IA interpreta e gera os PNGs
                </label>
              </div>
            </div>

            <div id="direct-content-field" style="display:none" class="form-group">
              <label style="font-size:.85rem">Conteúdo e instruções dos slides</label>
              <textarea id="direct-slides-content" rows="8" style="font-size:.82rem" placeholder="Escreva como você falaria comigo. Ex.:&#10;&#10;Slide 1: gancho forte sobre fome emocional&#10;Depois 3 slides explicando os sinais&#10;Último slide: CTA pro quiz no link&#10;Assinatura Evelyn Liu - Nutricionista (tipografia menor, em itálico)&#10;Usar foto no slide 2"></textarea>
              <p style="font-size:.75rem;color:var(--muted);margin-top:4px">Escreva livremente — a IA lê, entende as instruções (assinatura, foto, cor, título) e organiza os slides. Não precisa numerar nem formatar.</p>
            </div>

            <div class="form-group" style="margin-bottom:0">
              <label style="font-size:.85rem">Pasta de fotos no Google Drive <span style="color:var(--muted)">(opcional)</span></label>
              <input type="url" id="drive-folder-url" placeholder="https://drive.google.com/drive/folders/..." style="font-size:.85rem">
              <p style="font-size:.75rem;color:var(--muted);margin-top:4px">As fotos serão usadas como fundo sutil nos slides. Compartilhe a pasta com a service account.</p>
            </div>
          </div>
        </div>

        <button type="submit" class="btn btn-accent btn-full" id="gen-submit-btn">Gerar com IA</button>
      </form>
    </div>
    <div id="gen-result" style="max-width:680px;margin-top:20px"></div>
  `;

  // Mostra/oculta campos de carrossel e ajusta label do botão
  const formatSel = el.querySelector('#gen-format');
  const carouselExtras = el.querySelector('#carousel-extras');
  const submitBtn = el.querySelector('#gen-submit-btn');
  const directField = el.querySelector('#direct-content-field');

  function updateCarouselUI() {
    const isCarousel = ['carrossel','carrossel_video'].includes(formatSel.value);
    carouselExtras.style.display = isCarousel ? 'block' : 'none';
    const mode = el.querySelector('input[name="carousel_mode"]:checked')?.value || 'ai';
    if (isCarousel && mode === 'direct') {
      submitBtn.textContent = 'Gerar slides PNG';
      directField.style.display = 'block';
      el.querySelector('#gen-briefing').required = false;
    } else {
      submitBtn.textContent = 'Gerar com IA';
      directField.style.display = 'none';
      el.querySelector('#gen-briefing').required = true;
    }
  }

  formatSel.addEventListener('change', updateCarouselUI);
  el.querySelectorAll('input[name="carousel_mode"]').forEach(r => r.addEventListener('change', updateCarouselUI));

  // Helper para renderizar resultado de carrossel (slides PNG)
  function renderCarouselResult(resultEl, cardId, driveFolderUrl) {
    return `
      <div style="margin-top:14px;border-top:1px solid var(--bege);padding-top:14px">
        <button class="btn btn-accent btn-sm" id="inline-carousel-btn">Gerar slides PNG</button>
        <div id="inline-carousel-result" style="margin-top:10px"></div>
      </div>`;
  }

  function attachCarouselBtn(resultEl, cardId, driveFolderUrl) {
    const btn = resultEl.querySelector('#inline-carousel-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Gerando slides...';
      const slideResult = resultEl.querySelector('#inline-carousel-result');
      slideResult.innerHTML = '<div class="loading"><div class="spinner"></div> Renderizando slides via Puppeteer...</div>';
      try {
        const data = await api('POST', `/cards/${cardId}/carousel`, driveFolderUrl ? { drive_folder_url: driveFolderUrl } : undefined);
        slideResult.innerHTML = `
          <div style="background:var(--bege);border-radius:8px;padding:14px;display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:.9rem"><strong>${data.slides} slides</strong> gerados (1080×1080px, 2×)</span>
            <a href="${encodeURI(data.download_url)}" download class="btn btn-accent btn-sm">Baixar ZIP</a>
          </div>`;
        toast(`${data.slides} slides prontos!`);
      } catch (e) {
        slideResult.innerHTML = `<p style="color:#c0392b;font-size:.85rem">Erro: ${safeHtml(e.message)}</p>`;
        toast(e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Gerar slides PNG';
      }
    });
  }

  el.querySelector('#gen-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('#gen-submit-btn');
    btn.disabled = true;
    const result = document.getElementById('gen-result');
    const format = formatSel.value;
    const isCarousel = ['carrossel','carrossel_video'].includes(format);
    const mode = el.querySelector('input[name="carousel_mode"]:checked')?.value || 'ai';
    const driveFolderUrl = el.querySelector('#drive-folder-url').value.trim() || null;

    // Modo direto: já tem slides, gera PNG sem IA
    if (isCarousel && mode === 'direct') {
      const content = el.querySelector('#direct-slides-content').value.trim();
      if (!content) { toast('Cole o conteúdo dos slides', 'error'); btn.disabled = false; return; }
      btn.textContent = 'Gerando slides...';
      result.innerHTML = '<div class="loading"><div class="spinner"></div> Renderizando slides via Puppeteer...</div>';
      try {
        const data = await api('POST', '/cards/carousel-direct', { content, drive_folder_url: driveFolderUrl });
        result.innerHTML = `
          <div class="card">
            <div style="background:var(--bege);border-radius:8px;padding:14px;display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:.9rem"><strong>${data.slides} slides</strong> gerados (1080×1080px, 2×)</span>
              <a href="${encodeURI(data.download_url)}" download class="btn btn-accent btn-sm">Baixar ZIP</a>
            </div>
          </div>`;
        toast(`${data.slides} slides prontos!`);
      } catch (err) {
        result.innerHTML = `<div class="card" style="border-left:4px solid #c0392b"><p style="color:#c0392b">Erro: ${safeHtml(err.message)}</p></div>`;
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Gerar slides PNG';
      }
      return;
    }

    // Modo IA (padrão)
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    btn.textContent = 'Gerando...';
    result.innerHTML = '<div class="loading"><div class="spinner"></div> Gerando conteúdo com IA...</div>';
    try {
      const card = await api('POST', '/generate/content', body);
      result.innerHTML = `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <h3 style="font-family:'Cormorant Garamond',serif;color:var(--verde)">Conteúdo gerado</h3>
            <span class="badge" style="background:#f0e8ff;color:#5a2d9a">IA · salvo como roteiro</span>
          </div>
          <div class="ai-output">${safeHtml(card.content) || '(sem conteúdo)'}</div>
          <p style="color:var(--muted);font-size:.8rem;margin-top:10px">Card #${card.id} salvo no calendário como rascunho.</p>
          ${isCarousel ? renderCarouselResult(result, card.id, driveFolderUrl) : ''}
        </div>
      `;
      if (isCarousel) attachCarouselBtn(result, card.id, driveFolderUrl);
      toast('Conteúdo gerado e salvo!');
    } catch (err) {
      result.innerHTML = `<div class="card" style="border-left:4px solid #c0392b"><p style="color:#c0392b">Erro: ${err.message}</p></div>`;
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = isCarousel ? 'Gerar slides PNG' : 'Gerar com IA';
    }
  });
}

// ── Anúncios ───────────────────────────────────────────
async function anuncios(el) {
  el.innerHTML = `
    <div class="page-header"><h1>Fábrica de Anúncios</h1></div>
    <div style="display:grid;grid-template-columns:340px 1fr;gap:24px;align-items:start">
      <div class="card">
        <form id="ads-form">
          <div class="form-group"><label>Objetivo do anúncio</label>
            <input name="objective" placeholder="Ex: Capturar leads para o Método TableClinic" required>
          </div>
          <div class="form-group"><label>Produto / Serviço</label>
            <input name="product" placeholder="Ex: Programa de 12 semanas de nutrição comportamental" required>
          </div>
          <div class="form-group"><label>Público-alvo</label>
            <textarea name="audience" rows="3" placeholder="Ex: Mulheres 30-50 anos que sofrem com compulsão alimentar e já tentaram dietas..." required></textarea>
          </div>
          <button type="submit" class="btn btn-accent btn-full">Gerar Copies</button>
        </form>
      </div>
      <div id="ads-result"></div>
    </div>
    <div style="margin-top:32px">
      <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.3rem;margin-bottom:16px;color:var(--verde)">Histórico</h3>
      <div id="ads-history"></div>
    </div>
  `;

  async function loadHistory() {
    const items = await api('GET', '/ads');
    const el2 = document.getElementById('ads-history');
    if (!items.length) { el2.innerHTML = '<p style="color:var(--muted)">Nenhum copy gerado ainda.</p>'; return; }
    el2.innerHTML = items.map(a => `
      <div class="ad-copy-card" style="cursor:pointer" data-id="${a.id}">
        <div class="copy-num">${formatDate(a.created_at)}</div>
        <strong>${a.product}</strong>
        <p style="font-size:.82rem;color:var(--muted);margin-top:4px">${a.objective}</p>
      </div>
    `).join('');
  }

  el.querySelector('#ads-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Gerando...';
    const result = document.getElementById('ads-result');
    result.innerHTML = '<div class="loading"><div class="spinner"></div> Gerando variações...</div>';

    try {
      const fd = new FormData(e.target);
      const rec = await api('POST', '/generate/ads', Object.fromEntries(fd.entries()));
      const copies = rec.copies || [];
      result.innerHTML = copies.map((c,i) => `
        <div class="ad-copy-card">
          <div class="copy-num" style="display:flex;justify-content:space-between">
            <span>Variação ${i+1}</span>
            <button class="btn btn-sm btn-outline copy-btn" data-text="${encodeURIComponent(c.text)}">Copiar</button>
          </div>
          <pre>${safeHtml(c.text)}</pre>
        </div>
      `).join('');
      result.querySelectorAll('.copy-btn').forEach(b => {
        b.addEventListener('click', () => {
          navigator.clipboard.writeText(decodeURIComponent(b.dataset.text));
          toast('Copiado!');
        });
      });
      await loadHistory();
    } catch (err) {
      result.innerHTML = `<p style="color:#c0392b">Erro: ${err.message}</p>`;
      toast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Gerar Copies';
    }
  });

  await loadHistory();
}

// ── Repurposing ────────────────────────────────────────
async function repurposing(el) {
  el.innerHTML = `
    <div class="page-header"><h1>Repurposing</h1></div>
    <div style="max-width:780px">
      <div class="card" style="margin-bottom:20px">
        <div class="form-group">
          <label>Cole a transcrição ou conteúdo longo</label>
          <textarea id="transcricao" rows="10" placeholder="Cole aqui o texto da live, do podcast, do artigo ou da aula..." style="width:100%"></textarea>
        </div>
        <button class="btn btn-accent" id="repurpose-btn">Gerar Repurposing</button>
      </div>
      <div id="repurpose-result"></div>
    </div>
  `;

  el.querySelector('#repurpose-btn').addEventListener('click', async () => {
    const transcricao = el.querySelector('#transcricao').value.trim();
    if (!transcricao) { toast('Cole uma transcrição primeiro', 'error'); return; }
    const btn = el.querySelector('#repurpose-btn');
    btn.disabled = true; btn.textContent = 'Processando...';
    const result = document.getElementById('repurpose-result');
    result.innerHTML = '<div class="loading"><div class="spinner"></div> Analisando conteúdo...</div>';

    try {
      const data = await api('POST', '/generate/repurpose', { transcricao });
      result.innerHTML = `
        <div class="card">
          <h3 style="font-family:'Cormorant Garamond',serif;color:var(--verde);margin-bottom:16px">Outputs gerados</h3>
          <div class="ai-output">${safeHtml(data.result)}</div>
        </div>
      `;
      toast('Repurposing gerado!');
    } catch (err) {
      result.innerHTML = `<p style="color:#c0392b">Erro: ${err.message}</p>`;
      toast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Gerar Repurposing';
    }
  });
}

// ── Edição ─────────────────────────────────────────────
async function edicao(el) {
  el.innerHTML = `
    <div class="page-header"><h1>Edição de Vídeo</h1></div>
    <div style="max-width:720px">
      <div class="card" style="margin-bottom:16px">
        <div class="form-group">
          <label>URLs dos vídeos — <strong>uma por linha</strong> (link direto MP4/MOV/WebM)</label>
          <textarea id="video-urls" rows="5" placeholder="https://bucket/video1.mp4&#10;https://bucket/video2.mp4&#10;https://bucket/video3.mp4"></textarea>
          <p style="font-size:.75rem;color:var(--muted);margin-top:4px">Cole vários links e deixe rolar — entram numa <strong>fila de produção</strong> e vão sendo entregues conforme ficam prontos.</p>
        </div>
        <div class="form-group">
          <label>Instruções em linguagem natural <span style="color:var(--muted);font-weight:400">(opcional — aplicadas a todos)</span></label>
          <textarea id="video-instructions" rows="4" placeholder="Ex: legendas, 9:16, cortar pausas agressivo, zoom"></textarea>
          <p style="font-size:.75rem;color:var(--muted);margin-top:4px">Em branco já faz <strong>corte de pausas + legendas</strong> automaticamente.</p>
        </div>
        <button class="btn btn-accent" id="edit-btn">Adicionar à fila</button>
      </div>

      <div id="edit-queue"></div>
    </div>
  `;

  const queueEl = el.querySelector('#edit-queue');
  let seq = 0;
  const rows = new Map();   // jobId → rowEl (jobs ainda não finalizados)
  let pollerOn = false;

  function opsResumo(ops = {}) {
    return [
      ops.trim ? `Corte ${ops.trim.start}–${ops.trim.end}s` : null,
      ops.resize ? `Resize ${ops.resize}` : null,
      ops.speed ? `${ops.speed}×` : null,
      ops.removeSilence ? `Pausas removidas` : null,
      ops.subtitles ? `Legendas` : null,
      ops.subtitles_warning ? `⚠ legenda: ${ops.subtitles_warning}` : null,
    ].filter(Boolean).join(' · ');
  }

  function shortUrl(u) {
    try { const p = new URL(u); return p.pathname.split('/').pop() || p.hostname; } catch { return u.slice(0, 40); }
  }

  // Poller único: consulta TODOS os jobs ativos num request em lote (evita
  // estourar o rate-limit ao polar 5+ vídeos ao mesmo tempo).
  async function startPoller() {
    if (pollerOn) return;
    pollerOn = true;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    while (rows.size) {
      await sleep(3000);
      const ids = [...rows.keys()];
      let map;
      try { map = await api('GET', `/edit/status-batch?ids=${ids.join(',')}`); }
      catch { continue; }
      for (const id of ids) {
        const s = map[id]; const row = rows.get(id);
        if (!s || !row) continue;
        if (s.status === 'queued')          setRow(row, 'queued', s);
        else if (s.status === 'processing') setRow(row, 'processing', s);
        else if (s.status === 'error')      { setRow(row, 'error', s); rows.delete(id); }
        else if (s.status === 'gone')       { setRow(row, 'error', { error: 'Job expirou (servidor reiniciou)' }); rows.delete(id); }
        else if (s.status === 'done')       { setRow(row, 'done', s); rows.delete(id); }
      }
    }
    pollerOn = false;
  }

  function setRow(rowEl, status, data) {
    const url = rowEl.dataset.url;
    const body = rowEl.querySelector('.eq-body');
    const badge = rowEl.querySelector('.eq-badge');
    rowEl.className = `eq-row eq-${status}`;
    if (status === 'queued') {
      badge.textContent = data.position ? `na fila (${data.position}º)` : 'na fila';
      body.innerHTML = '';
    } else if (status === 'processing') {
      badge.textContent = 'processando…';
      body.innerHTML = '<div class="eq-bar"><div></div></div>';
    } else if (status === 'error') {
      badge.textContent = 'erro';
      body.innerHTML = `<div style="color:#c0392b;font-size:.82rem">${safeHtml(data.error || 'Falha')}</div>`;
    } else if (status === 'done') {
      badge.textContent = 'pronto';
      body.innerHTML = `
        <div style="font-size:.8rem;color:var(--muted);margin-bottom:8px">${data.duration_original}s → ${data.duration_output}s · ${data.size_mb} MB · ${safeHtml(opsResumo(data.ops_applied))}</div>
        <a href="${encodeURI(data.download_url)}" download class="btn btn-accent" style="padding:6px 14px;font-size:.85rem">Baixar MP4</a>`;
    }
  }

  el.querySelector('#edit-btn').addEventListener('click', async () => {
    const urls = el.querySelector('#video-urls').value.split('\n').map(u => u.trim()).filter(Boolean);
    const instructions = el.querySelector('#video-instructions').value.trim();
    if (!urls.length) { toast('Cole pelo menos uma URL', 'error'); return; }

    const btn = el.querySelector('#edit-btn');
    btn.disabled = true; btn.textContent = 'Enfileirando…';
    try {
      const start = await api('POST', '/edit/video', { video_urls: urls, instructions });
      const list = start.jobs || [{ job_id: start.job_id, video_url: urls[0] }];
      toast(`${list.length} vídeo(s) na fila (processa ${start.concurrency || 2} por vez)`);

      for (const j of list) {
        seq++;
        const row = document.createElement('div');
        row.className = 'eq-row eq-queued';
        row.dataset.url = j.video_url;
        row.innerHTML = `
          <div class="eq-head">
            <span class="eq-name">#${seq} · ${safeHtml(shortUrl(j.video_url))}</span>
            <span class="eq-badge">na fila</span>
          </div>
          <div class="eq-body"></div>`;
        queueEl.prepend(row);
        rows.set(j.job_id, row);
      }
      startPoller(); // um poller só, em lote
      el.querySelector('#video-urls').value = '';
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Adicionar à fila';
    }
  });
}

// ── Mercado ────────────────────────────────────────────
async function mercado(el) {
  el.innerHTML = `
    <div class="page-header"><h1>Inteligência de Mercado</h1></div>
    <div style="display:grid;grid-template-columns:320px 1fr;gap:24px;align-items:start">
      <div class="card">
        <div class="form-group">
          <label>Tema ou briefing de pesquisa</label>
          <textarea id="market-tema" rows="5" placeholder="Ex: Tendências em alimentação intuitiva no Instagram BR, concorrentes que falam de comportamento alimentar..."></textarea>
        </div>
        <button class="btn btn-accent btn-full" id="market-btn">Pesquisar</button>
      </div>
      <div id="market-result"></div>
    </div>
    <div style="margin-top:32px">
      <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.3rem;margin-bottom:16px;color:var(--verde)">Relatórios anteriores</h3>
      <div id="market-history" class="card-grid"></div>
    </div>
  `;

  async function loadHistory() {
    const reports = await api('GET', '/market/reports');
    const h = document.getElementById('market-history');
    if (!reports.length) { h.innerHTML = '<p style="color:var(--muted)">Nenhum relatório ainda.</p>'; return; }
    h.innerHTML = reports.map(r => `
      <div class="report-card" data-id="${r.id}">
        <h4>${r.title}</h4>
        <p class="meta">${formatDate(r.generated_at)} · ${r.created_by_name || 'sistema'}</p>
      </div>
    `).join('');
    h.querySelectorAll('.report-card').forEach(c => {
      c.addEventListener('click', async () => {
        const r = await api('GET', '/market/reports/' + c.dataset.id);
        openModal(`<button class="modal-close">×</button><h2>${safeHtml(r.title)}</h2><div class="ai-output" style="margin-top:16px">${safeHtml(r.content)}</div>`);
      });
    });
  }

  el.querySelector('#market-btn').addEventListener('click', async () => {
    const tema = el.querySelector('#market-tema').value.trim();
    if (!tema) { toast('Preencha o tema', 'error'); return; }
    const btn = el.querySelector('#market-btn');
    btn.disabled = true; btn.textContent = 'Pesquisando...';
    const result = document.getElementById('market-result');
    result.innerHTML = '<div class="loading"><div class="spinner"></div> Analisando mercado...</div>';

    try {
      const report = await api('POST', '/market/research', { tema });
      result.innerHTML = `
        <div class="card">
          <h3 style="font-family:'Cormorant Garamond',serif;color:var(--verde);margin-bottom:12px">${report.title}</h3>
          <div class="ai-output">${safeHtml(report.content)}</div>
        </div>
      `;
      await loadHistory();
      toast('Relatório gerado!');
    } catch (err) {
      result.innerHTML = `<p style="color:#c0392b">Erro: ${err.message}</p>`;
      toast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Pesquisar';
    }
  });

  await loadHistory();
}

// ── Insights ───────────────────────────────────────────
async function insights(el) {
  el.innerHTML = `
    <div class="page-header"><h1>Performance & Insights</h1></div>

    <div class="card" style="margin-bottom:16px">
      <h3 style="font-family:'Cormorant Garamond',serif;color:var(--verde);margin-bottom:6px">Importar histórico (CSV do Meta)</h3>
      <p style="font-size:.82rem;color:var(--muted);margin-bottom:10px">Suba o export do Meta Business Suite. Aqui o histórico é amplo (90 dias / 1 ano) — cada upload soma/atualiza por post (dedup automático).</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <label class="btn btn-outline" style="cursor:pointer">Escolher .csv<input type="file" id="ins-file" accept=".csv,text/csv" style="display:none"></label>
        <span id="ins-fname" style="font-size:.82rem;color:var(--muted)"></span>
      </div>
      <textarea id="ins-csv" class="ed-textarea" rows="4" placeholder="…ou cole o CSV aqui"></textarea>
      <div style="margin-top:10px"><button class="btn btn-primary" id="ins-upload">Importar</button></div>
      <div id="ins-upload-result" style="margin-top:10px"></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:14px">
        <h3 style="font-family:'Cormorant Garamond',serif;color:var(--verde)">Visão geral</h3>
        <div style="display:flex;gap:6px;align-items:center">
          <select id="ins-period" class="input" style="width:150px">
            <option value="30">Últimos 30 dias</option>
            <option value="90" selected>Últimos 90 dias</option>
            <option value="180">Últimos 6 meses</option>
            <option value="365">Último ano</option>
          </select>
          <button class="btn btn-accent btn-sm" id="ins-analyze">Analisar com IA</button>
        </div>
      </div>
      <div id="ins-overview"><div class="loading"><div class="spinner"></div> Carregando…</div></div>
    </div>

    <div id="ins-analysis" style="margin-bottom:16px"></div>
    <div id="insights-data"></div>
  `;

  const fmt = n => (n==null) ? '—' : Number(n).toLocaleString('pt-BR');
  const pct = n => (n==null) ? '—' : (n*100).toFixed(2)+'%';
  const typeBadge = t => ({ REELS:'Reel', VIDEO:'Vídeo', CAROUSEL_ALBUM:'Carrossel', IMAGE:'Imagem', FEED:'Feed', STORY:'Story', 'Reel do Instagram':'Reel', 'Carrossel do Instagram':'Carrossel', 'Imagem do Instagram':'Imagem' }[t] || t || 'Post');
  let curDays = 90;

  async function loadOverview(days) {
    curDays = days;
    const box = document.getElementById('ins-overview');
    box.innerHTML = '<div class="loading"><div class="spinner"></div> Carregando…</div>';
    try {
      const d = await api('GET', `/insights/overview?days=${days}`);
      if (!d.total_posts) { box.innerHTML = '<p style="color:var(--muted)">Sem dados no período. Faça o upload do CSV acima.</p>'; return; }
      const t = d.totais, m = d.medianas;
      const stat = (label,val) => `<div style="background:var(--bege);border-radius:8px;padding:12px;text-align:center;flex:1;min-width:90px"><div style="font-size:1.3rem;font-family:'Cormorant Garamond',serif">${val}</div><div style="font-size:.7rem;color:var(--muted)">${label}</div></div>`;
      const topRow = p => `<div style="display:flex;gap:10px;align-items:center;background:var(--bege);border-radius:8px;padding:10px">
        <div style="flex:1;min-width:0"><div style="font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${typeBadge(p.post_type)} · ${safeHtml(p.description||'(sem legenda)')}</div>
        <div style="font-size:.72rem;color:var(--muted)">${fmt(p.reach)} alcance · ${pct(p.taxa_engajamento)} eng · ${pct(p.taxa_salvamento)} salv · ${pct(p.taxa_seguidor)} seg</div></div>
        ${p.permalink?`<a href="${p.permalink}" target="_blank" style="color:var(--terracota);font-size:.8rem">↗</a>`:''}</div>`;
      box.innerHTML = `
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
          ${stat('posts', fmt(d.total_posts))}${stat('alcance', fmt(t.alcance))}${stat('salvamentos', fmt(t.salvamentos))}${stat('novos seguidores', fmt(t.seguidores))}${stat('comentários', fmt(t.comentarios))}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
          ${stat('mediana eng.', pct(m.engajamento))}${stat('mediana salv.', pct(m.salvamento))}${stat('mediana seguidor', pct(m.seguidor))}${stat('mediana envio', pct(m.envio))}
        </div>
        ${d.por_tipo?.length?`<div style="font-size:.72rem;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Por formato</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">${d.por_tipo.map(x=>`<div style="background:var(--bege);border-radius:8px;padding:8px 12px;font-size:.8rem"><strong>${typeBadge(x.tipo)}</strong> · ${x.posts} posts · eng ${pct(x.mediana_engajamento)} · salv ${pct(x.mediana_salvamento)}</div>`).join('')}</div>`:''}
        <div style="font-size:.72rem;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Top por engajamento</div>
        <div style="display:flex;flex-direction:column;gap:8px">${(d.top_engajamento||[]).map(topRow).join('')}</div>`;
    } catch (e) { box.innerHTML = `<p style="color:#c0392b">Erro: ${safeHtml(e.message)}</p>`; }
  }

  // upload CSV
  el.querySelector('#ins-file').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    el.querySelector('#ins-fname').textContent = f.name;
    el.querySelector('#ins-csv').value = await f.text();
  });
  el.querySelector('#ins-upload').addEventListener('click', async () => {
    const csv = el.querySelector('#ins-csv').value.trim();
    if (!csv) { toast('Cole ou selecione um CSV', 'error'); return; }
    const btn = el.querySelector('#ins-upload'); btn.disabled = true; btn.textContent = 'Importando…';
    const res = document.getElementById('ins-upload-result');
    try {
      const d = await api('POST', '/insights/upload-csv', { csv });
      res.innerHTML = `<div class="ed-result-box ed-result-ok">${d.inserted} novos · ${d.updated} atualizados · ${d.total} no arquivo${d.warnings?.length?`<div class="ed-warnings">${d.warnings.slice(0,5).map(w=>`<div>⚠ ${safeHtml(w)}</div>`).join('')}</div>`:''}</div>`;
      el.querySelector('#ins-csv').value=''; el.querySelector('#ins-fname').textContent='';
      toast('Histórico importado!'); loadOverview(curDays);
    } catch (e) { res.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(e.message)}</div>`; toast(e.message,'error'); }
    finally { btn.disabled=false; btn.textContent='Importar'; }
  });

  el.querySelector('#ins-period').addEventListener('change', e => loadOverview(parseInt(e.target.value,10)));

  el.querySelector('#ins-analyze').addEventListener('click', async () => {
    const btn = el.querySelector('#ins-analyze'); btn.disabled=true; btn.textContent='Analisando…';
    const out = document.getElementById('ins-analysis');
    out.innerHTML = '<div class="card"><div class="loading"><div class="spinner"></div> A IA está analisando…</div></div>';
    try {
      const r = await api('POST', '/insights/analyze', { days: curDays });
      out.innerHTML = `<div class="card"><h3 style="font-family:'Cormorant Garamond',serif;color:var(--verde);margin-bottom:12px">Análise da IA · ${curDays} dias</h3><div class="ai-output">${safeHtml(r.analysis)}</div></div>`;
      toast('Análise gerada!');
    } catch (e) { out.innerHTML = `<div class="card"><p style="color:#c0392b">Erro: ${safeHtml(e.message)}</p></div>`; toast(e.message,'error'); }
    finally { btn.disabled=false; btn.textContent='Analisar com IA'; }
  });

  loadOverview(90);

  // Meta Ads — seção secundária (mantida)
  try {
    const data = await api('GET', '/insights');
    const container = document.getElementById('insights-data');
    const campaigns = data.data || [];
    if (campaigns.length) {
      container.innerHTML = `
        <div class="card" style="margin-bottom:16px">
          <h3 style="font-family:'Cormorant Garamond',serif;color:var(--verde);margin-bottom:12px">Campanhas Meta Ads</h3>
          <div class="card-grid">
            ${campaigns.slice(0,6).map(c=>`
              <div style="background:var(--bege);border-radius:8px;padding:12px">
                <strong style="font-size:.9rem">${safeHtml(c.name)}</strong>
                <p style="font-size:.8rem;color:var(--muted);margin-top:4px">${safeHtml(c.status)} · ${safeHtml(c.objective || '')}</p>
              </div>
            `).join('')}
          </div>
        </div>`;
    }
  } catch {}
}

// ── Admin ──────────────────────────────────────────────
async function admin(el) {
  el.innerHTML = `
    <div class="page-header"><h1>Administração</h1></div>
    <div style="display:grid;grid-template-columns:1fr 360px;gap:24px;align-items:start">
      <div>
        <h3 style="font-family:'Cormorant Garamond',serif;font-size:1.3rem;margin-bottom:16px;color:var(--verde)">Usuários</h3>
        <div id="users-list"></div>
      </div>
      <div class="card">
        <h4 style="margin-bottom:16px">Novo usuário</h4>
        <form id="new-user-form">
          <div class="form-group"><label>Nome</label><input name="name" required></div>
          <div class="form-group"><label>Email</label><input type="email" name="email" required></div>
          <div class="form-group"><label>Senha</label><input type="password" name="password" required></div>
          <div class="form-group"><label>Role</label>
            <select name="role">
              <option value="admin">Admin</option><option value="evelyn">Evelyn</option>
              <option value="editor">Editor</option><option value="nutri">Nutri</option>
            </select>
          </div>
          <div class="form-group"><label>Nome nutri (se nutri)</label><input name="nutri_name"></div>
          <div class="form-group"><label>WhatsApp</label><input name="whatsapp" placeholder="5511999999999"></div>
          <button type="submit" class="btn btn-primary btn-full">Criar usuário</button>
        </form>
      </div>
    </div>
  `;

  async function loadUsers() {
    const users = await api('GET', '/users');
    const list = document.getElementById('users-list');
    list.innerHTML = `
      <table style="width:100%;border-collapse:collapse;background:white;border-radius:10px;overflow:hidden;box-shadow:var(--shadow)">
        <thead><tr style="background:var(--verde);color:var(--bege)">
          <th style="padding:12px;text-align:left;font-weight:500">Nome</th>
          <th style="padding:12px;text-align:left;font-weight:500">Email</th>
          <th style="padding:12px;text-align:left;font-weight:500">Role</th>
          <th style="padding:12px;text-align:left;font-weight:500">Criado em</th>
        </tr></thead>
        <tbody>
          ${users.map((u,i)=>`
            <tr style="border-bottom:1px solid var(--bege-dark);${i%2?'background:var(--bege)':''}">
              <td style="padding:12px">${u.name}${u.nutri_name?` <span style="color:var(--muted);font-size:.8rem">(${u.nutri_name})</span>`:''}</td>
              <td style="padding:12px;font-size:.88rem">${u.email}</td>
              <td style="padding:12px">${badgeStatus(u.role)}</td>
              <td style="padding:12px;font-size:.82rem;color:var(--muted)">${formatDate(u.created_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  el.querySelector('#new-user-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', '/users', Object.fromEntries(fd.entries()));
      toast('Usuário criado!');
      e.target.reset();
      await loadUsers();
    } catch (err) { toast(err.message, 'error'); }
  });

  await loadUsers();
}

// ── Editorial Engine ───────────────────────────────────
async function editorial(el) {
  const EDITORIA_LABEL = {
    canetas_noticia:       'Canetas & Notícia',
    tipologico_absolvicao: 'Tipológico / Absolvição',
    identidade:            'Identidade',
    historia_consultorio:  'História do Consultório',
    reflexao_collab:       'Reflexão / Collab',
    outro:                 'Outro',
  };
  const EDITORIA_COLOR = {
    canetas_noticia:       'var(--verde)',
    tipologico_absolvicao: 'var(--terracota)',
    identidade:            '#7a6a9a',
    historia_consultorio:  '#4a7a8a',
    reflexao_collab:       'var(--muted)',
    outro:                 'var(--bege-dark)',
  };

  // Estado local da aba ativa
  let activeTab = 'semana';

  function pct(n) { return n != null ? (n * 100).toFixed(2) + '%' : '—'; }
  function shortDesc(d) { return safeHtml((d || '').slice(0, 90) + ((d || '').length > 90 ? '…' : '')); }

  function renderTabs() {
    return `
      <div class="ed-tabs">
        <button class="ed-tab ${activeTab === 'semana'    ? 'active' : ''}" data-tab="semana">🗓 Semana</button>
        <button class="ed-tab ${activeTab === 'dashboard' ? 'active' : ''}" data-tab="dashboard">📊 Dashboard</button>
        <button class="ed-tab ${activeTab === 'radar'     ? 'active' : ''}" data-tab="radar">📡 Radar</button>
        <button class="ed-tab ${activeTab === 'posts'     ? 'active' : ''}" data-tab="posts">Posts</button>
        <button class="ed-tab ${activeTab === 'mining'    ? 'active' : ''}" data-tab="mining">Mineração</button>
        <button class="ed-tab ${activeTab === 'upload'    ? 'active' : ''}" data-tab="upload">Upload CSV</button>
      </div>`;
  }

  function bindTabs() {
    el.querySelectorAll('.ed-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        render();
      });
    });
  }

  // ── Tab: Upload CSV ─────────────────────────────────
  function renderUpload() {
    return `
      <div class="ed-section">
        <h3 class="ed-section-title">Importar analytics do Instagram</h3>
        <p class="ed-hint">Cole o conteúdo do CSV exportado do Meta Business Suite (UTF-8). Contas processadas: <strong>nutrievelynliu</strong> e <strong>evelynlwl</strong>.</p>

        <div class="ed-upload-area">
          <label class="btn btn-outline" style="cursor:pointer">
            Escolher arquivo .csv
            <input type="file" id="ed-file-input" accept=".csv,text/csv" style="display:none">
          </label>
          <span id="ed-file-name" style="margin-left:10px;color:var(--muted);font-size:.85rem"></span>
        </div>

        <textarea id="ed-csv-text" class="ed-textarea" placeholder="…ou cole o CSV aqui" rows="8"></textarea>

        <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
          <button id="ed-upload-btn" class="btn btn-primary">Importar posts</button>
          <button id="ed-classify-btn" class="btn btn-outline">Classificar editorias (IA)</button>
        </div>

        <div id="ed-upload-result" style="margin-top:14px"></div>
      </div>`;
  }

  function bindUpload() {
    const fileInput  = el.querySelector('#ed-file-input');
    const fileName   = el.querySelector('#ed-file-name');
    const csvText    = el.querySelector('#ed-csv-text');
    const uploadBtn  = el.querySelector('#ed-upload-btn');
    const classifyBtn= el.querySelector('#ed-classify-btn');
    const resultDiv  = el.querySelector('#ed-upload-result');

    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      fileName.textContent = file.name;
      csvText.value = await file.text();
    });

    uploadBtn?.addEventListener('click', async () => {
      const csv = csvText.value.trim();
      if (!csv) { toast('Cole ou selecione um CSV primeiro', 'error'); return; }
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Importando…';
      resultDiv.innerHTML = '';
      try {
        const d = await api('POST', '/editorial/upload-csv', { csv });
        resultDiv.innerHTML = `
          <div class="ed-result-box ed-result-ok">
            <strong>${d.inserted}</strong> novos · <strong>${d.updated}</strong> atualizados · <strong>${d.total}</strong> total
            ${d.warnings?.length ? `<div class="ed-warnings">${d.warnings.map(w => `<div>⚠ ${safeHtml(w)}</div>`).join('')}</div>` : ''}
          </div>`;
        toast('CSV importado!');
      } catch (err) {
        resultDiv.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(err.message)}</div>`;
        toast(err.message, 'error');
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Importar posts';
      }
    });

    classifyBtn?.addEventListener('click', async () => {
      classifyBtn.disabled = true;
      classifyBtn.textContent = 'Classificando (pode levar ~30s)…';
      resultDiv.innerHTML = '';
      try {
        const d = await api('POST', '/editorial/classify', { limit: 200 });
        resultDiv.innerHTML = `
          <div class="ed-result-box ed-result-ok">
            <strong>${d.classified}</strong> posts classificados
            ${d.errors?.length ? `<div class="ed-warnings">${d.errors.map(e => `<div>⚠ ${safeHtml(e)}</div>`).join('')}</div>` : ''}
          </div>`;
        toast(`${d.classified} posts classificados!`);
      } catch (err) {
        resultDiv.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(err.message)}</div>`;
        toast(err.message, 'error');
      } finally {
        classifyBtn.disabled = false;
        classifyBtn.textContent = 'Classificar editorias (IA)';
      }
    });
  }

  // ── Tab: Posts ──────────────────────────────────────
  let postsData = null;
  let postsPage = 1;
  let postsEditoria = '';
  let postsSemEdit = false;

  async function loadPosts() {
    const params = new URLSearchParams({ page: postsPage, limit: 50 });
    if (postsEditoria) params.set('editoria', postsEditoria);
    if (postsSemEdit) params.set('sem_editoria', '1');
    const d = await api('GET', `/editorial/posts?${params}`);
    postsData = d;
  }

  function renderPostsTab() {
    if (!postsData) return `<div class="ed-loading">Carregando…</div>`;
    const { posts, total, page, limit } = postsData;
    const editorias = ['', ...Object.keys(EDITORIA_LABEL)];
    return `
      <div class="ed-section">
        <div class="ed-posts-filters">
          <select id="ed-filter-editoria" class="input" style="width:200px">
            ${editorias.map(e => `<option value="${e}" ${postsEditoria === e ? 'selected' : ''}>${e ? EDITORIA_LABEL[e] || e : 'Todas editorias'}</option>`).join('')}
          </select>
          <label style="display:flex;align-items:center;gap:6px;font-size:.88rem">
            <input type="checkbox" id="ed-filter-sem" ${postsSemEdit ? 'checked' : ''}> Sem classificação
          </label>
        </div>

        <div class="ed-posts-meta">${total} posts · página ${page} de ${Math.ceil(total / limit) || 1}</div>

        <div class="ed-table-wrap">
          <table class="ed-table">
            <thead><tr>
              <th>Tipo</th><th>Descrição</th><th>Data</th>
              <th>Alcance</th><th>Envios%</th><th>Salv%</th>
              <th>Editoria</th><th></th>
            </tr></thead>
            <tbody>
              ${posts.map(p => {
                const reach = p.reach || 1;
                const taxaEnvio = ((p.shares / reach) * 100).toFixed(2);
                const taxaSalv  = ((p.saves  / reach) * 100).toFixed(2);
                const edColor   = EDITORIA_COLOR[p.editoria] || 'var(--muted)';
                return `<tr>
                  <td><span class="ed-badge" style="background:${edColor}20;color:${edColor}">${safeHtml(p.post_type || '?')}</span></td>
                  <td class="ed-desc">${shortDesc(p.description)}</td>
                  <td style="white-space:nowrap;font-size:.8rem;color:var(--muted)">${p.published_at ? new Date(p.published_at).toLocaleDateString('pt-BR') : (p.date || '—')}</td>
                  <td style="text-align:right">${(p.reach || 0).toLocaleString('pt-BR')}</td>
                  <td style="text-align:right">${taxaEnvio}%</td>
                  <td style="text-align:right">${taxaSalv}%</td>
                  <td>
                    <select class="ed-select-editoria" data-id="${p.id}" style="font-size:.8rem;padding:2px 4px;border:1px solid var(--bege-dark);border-radius:4px;background:white">
                      <option value="">—</option>
                      ${Object.keys(EDITORIA_LABEL).map(e =>
                        `<option value="${e}" ${p.editoria === e ? 'selected' : ''}>${EDITORIA_LABEL[e]}</option>`
                      ).join('')}
                    </select>
                    ${p.editoria_manual ? '<span title="Corrigido manualmente" style="color:var(--terracota);margin-left:4px">✎</span>' : ''}
                  </td>
                  <td>${p.permalink ? `<a href="${safeHtml(p.permalink)}" target="_blank" style="font-size:.8rem;color:var(--verde)">↗</a>` : ''}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>

        <div class="ed-pagination">
          ${page > 1 ? `<button class="btn btn-outline ed-page-btn" data-page="${page - 1}">← Anterior</button>` : ''}
          ${posts.length === limit ? `<button class="btn btn-outline ed-page-btn" data-page="${page + 1}">Próxima →</button>` : ''}
        </div>
      </div>`;
  }

  function bindPosts() {
    el.querySelector('#ed-filter-editoria')?.addEventListener('change', e => {
      postsEditoria = e.target.value;
      postsSemEdit  = false;
      postsPage     = 1;
      render();
    });
    el.querySelector('#ed-filter-sem')?.addEventListener('change', e => {
      postsSemEdit  = e.target.checked;
      postsEditoria = '';
      postsPage     = 1;
      render();
    });
    el.querySelectorAll('.ed-select-editoria').forEach(sel => {
      sel.addEventListener('change', async () => {
        const id       = sel.dataset.id;
        const editoria = sel.value;
        if (!editoria) return;
        try {
          await api('PATCH', `/editorial/posts/${id}/editoria`, { editoria });
          toast('Editoria salva!');
        } catch (err) { toast(err.message, 'error'); }
      });
    });
    el.querySelectorAll('.ed-page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        postsPage = parseInt(btn.dataset.page, 10);
        render();
      });
    });
  }

  // ── Tab: Dashboard ──────────────────────────────────
  let analyticsData = null;

  async function loadAnalytics() {
    analyticsData = await api('GET', '/editorial/analytics');
  }

  function renderDashboard() {
    if (!analyticsData) return `<div class="ed-loading">Carregando…</div>`;
    const d = analyticsData;

    const alertasHtml = d.alertas_fadiga?.length
      ? `<div class="ed-alert">⚠ Editorias fatigando (últimos 3 posts abaixo de 50% da mediana): <strong>${d.alertas_fadiga.map(e => EDITORIA_LABEL[e] || e).join(', ')}</strong></div>`
      : '';

    const reencarnacaoHtml = d.fila_reencarnacao?.length
      ? `<div class="ed-card" style="margin-bottom:20px">
          <div class="ed-card-title">♻ Fila de Reencarnação (${d.fila_reencarnacao.length})</div>
          <div class="ed-table-wrap"><table class="ed-table">
            <thead><tr><th>Editoria</th><th>Descrição</th><th>Motivo</th><th>Link</th></tr></thead>
            <tbody>${d.fila_reencarnacao.map(p => `<tr>
              <td><span class="ed-badge" style="background:${EDITORIA_COLOR[p.editoria] || 'var(--muted)'}20;color:${EDITORIA_COLOR[p.editoria] || 'var(--muted)'}">${safeHtml(EDITORIA_LABEL[p.editoria] || p.editoria)}</span></td>
              <td class="ed-desc">${shortDesc(p.description)}</td>
              <td style="font-size:.8rem;color:var(--verde)">${safeHtml(p.razao)}</td>
              <td>${p.permalink ? `<a href="${safeHtml(p.permalink)}" target="_blank" style="font-size:.8rem;color:var(--verde)">↗</a>` : ''}</td>
            </tr>`).join('')}</tbody>
          </table></div>
        </div>`
      : '';

    const editoriaCards = Object.entries(d.por_editoria || {}).map(([ed, s]) => {
      const color = EDITORIA_COLOR[ed] || 'var(--muted)';
      const label = EDITORIA_LABEL[ed] || ed;
      const tend  = (s.tendencia_4semanas || []).map(t =>
        `<div class="ed-tend-week">
          <span style="font-size:.72rem;color:var(--muted)">${t.semana?.slice(5)}</span>
          <span>${t.posts} post${t.posts !== 1 ? 's' : ''}</span>
          ${t.media_envio != null ? `<span style="color:var(--verde)">${(t.media_envio*100).toFixed(2)}% env</span>` : ''}
        </div>`
      ).join('');

      return `<div class="ed-card">
        <div class="ed-card-header" style="border-left:4px solid ${color}">
          <span class="ed-card-title">${safeHtml(label)}</span>
          <span class="ed-card-count">${s.posts_count} posts</span>
        </div>
        <div class="ed-metrics-grid">
          <div class="ed-metric"><div class="ed-metric-label">Mediana Envios</div><div class="ed-metric-val">${pct(s.mediana_envio)}</div></div>
          <div class="ed-metric"><div class="ed-metric-label">Mediana Seguidores</div><div class="ed-metric-val">${pct(s.mediana_seguidor)}</div></div>
          <div class="ed-metric"><div class="ed-metric-label">Mediana Salvamentos</div><div class="ed-metric-val">${pct(s.mediana_salvamento)}</div></div>
          <div class="ed-metric"><div class="ed-metric-label">Mediana Comentários</div><div class="ed-metric-val">${pct(s.mediana_comentario)}</div></div>
        </div>
        <div class="ed-tend-row">${tend}</div>
        ${s.top_envio?.length ? `
        <div class="ed-top-label">Top envios</div>
        ${s.top_envio.slice(0,2).map(p => `
          <div class="ed-top-post">
            <span class="ed-top-desc">${shortDesc(p.description)}</span>
            <span class="ed-top-rate" style="color:var(--verde)">${pct(p.taxa_envio)}</span>
          </div>`).join('')}` : ''}
      </div>`;
    }).join('');

    const topGeralHtml = (type, arr, label) => arr?.length ? `
      <div>
        <div class="ed-top-label" style="margin-top:8px">${label}</div>
        ${arr.map(p => `<div class="ed-top-post">
          <span class="ed-top-desc">${shortDesc(p.description)}</span>
          <span class="ed-badge" style="background:${EDITORIA_COLOR[p.editoria]||'var(--muted)'}20;color:${EDITORIA_COLOR[p.editoria]||'var(--muted)'};font-size:.72rem">${EDITORIA_LABEL[p.editoria]||p.editoria||'?'}</span>
          <span class="ed-top-rate">${pct(p['taxa_' + type])}</span>
        </div>`).join('')}
      </div>` : '';

    return `
      <div class="ed-section">
        <div class="ed-summary">
          <div class="ed-stat"><div class="ed-stat-val">${d.total_posts}</div><div class="ed-stat-label">Posts totais</div></div>
          <div class="ed-stat"><div class="ed-stat-val" style="color:var(--terracota)">${d.sem_classificacao}</div><div class="ed-stat-label">Sem editoria</div></div>
          <div class="ed-stat"><div class="ed-stat-val">${d.fila_reencarnacao?.length || 0}</div><div class="ed-stat-label">Para reencarnar</div></div>
          <div class="ed-stat"><div class="ed-stat-val" style="color:${d.alertas_fadiga?.length ? 'var(--terracota)' : 'var(--verde)'}">${d.alertas_fadiga?.length || 0}</div><div class="ed-stat-label">Alertas fadiga</div></div>
        </div>

        ${alertasHtml}

        <div class="ed-two-col">
          <div>
            <h4 style="margin-bottom:12px">Por Editoria</h4>
            <div class="ed-editoria-grid">${editoriaCards}</div>
          </div>
          <div>
            <h4 style="margin-bottom:12px">Top Geral</h4>
            <div class="ed-card">
              ${topGeralHtml('envio',     d.top_geral?.envio,     '🚀 Maiores envios')}
              ${topGeralHtml('seguidor',  d.top_geral?.seguidor,  '👤 Maiores seguidores')}
              ${topGeralHtml('salvamento',d.top_geral?.salvamento,'🔖 Maiores salvamentos')}
            </div>
          </div>
        </div>

        ${reencarnacaoHtml}

        ${d.sem_classificacao > 0 ? `
          <div class="ed-hint" style="margin-top:12px">
            ${d.sem_classificacao} posts sem editoria.
            <button id="ed-quick-classify" class="btn btn-outline" style="margin-left:8px;padding:4px 10px;font-size:.82rem">Classificar agora (IA)</button>
          </div>` : ''}
      </div>`;
  }

  function bindDashboard() {
    el.querySelector('#ed-quick-classify')?.addEventListener('click', async btn => {
      const b = el.querySelector('#ed-quick-classify');
      b.disabled = true; b.textContent = 'Classificando…';
      try {
        const d = await api('POST', '/editorial/classify', { limit: 200 });
        toast(`${d.classified} posts classificados!`);
        analyticsData = null;
        await loadAnalytics();
        render();
      } catch (err) { toast(err.message, 'error'); b.disabled = false; b.textContent = 'Classificar agora (IA)'; }
    });
  }

  // ── Tab: Mineração ─────────────────────────────────
  const MINING_LABEL = {
    frase_de_seguidora: 'Frase de seguidora',
    referencia_formato: 'Referência de formato',
    noticia:            'Notícia',
    ideia_solta:        'Ideia solta',
  };
  const MINING_COLOR = {
    frase_de_seguidora: 'var(--terracota)',
    referencia_formato: '#4a7a8a',
    noticia:            'var(--verde)',
    ideia_solta:        '#7a6a9a',
  };
  const STATUS_LABEL = { novo: 'Novo', usado: 'Usado', arquivado: 'Arquivado' };
  const STATUS_COLOR = { novo: 'var(--verde)', usado: 'var(--terracota)', arquivado: 'var(--muted)' };

  let miningData   = null;
  let miningPage   = 1;
  let miningFilter = { type: '', status: 'novo', editoria_provavel: '', hook_potencial: '' };

  async function loadMining() {
    const params = new URLSearchParams({ page: miningPage, limit: 60 });
    if (miningFilter.type)              params.set('type', miningFilter.type);
    if (miningFilter.status)            params.set('status', miningFilter.status);
    if (miningFilter.editoria_provavel) params.set('editoria_provavel', miningFilter.editoria_provavel);
    if (miningFilter.hook_potencial)    params.set('hook_potencial', miningFilter.hook_potencial);
    miningData = await api('GET', `/editorial/mining?${params}`);
  }

  function renderMiningAdd() {
    return `
      <div class="ed-card" style="margin-bottom:16px">
        <div class="ed-card-title" style="margin-bottom:12px">Adicionar em lote</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
          <select id="mn-type" class="input" style="width:190px">
            ${Object.entries(MINING_LABEL).map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
          </select>
          <input id="mn-source" class="input" placeholder="URL fonte (notícias)" style="flex:1;min-width:180px">
          <input id="mn-expires" type="date" class="input" style="width:150px" title="Data de validade (para notícias)">
        </div>
        <textarea id="mn-text" class="ed-textarea" rows="6"
          placeholder="Uma entrada por linha. Cole frases de comentários, DMs, ideias soltas, links com descrição…"></textarea>
        <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:center">
          <label class="btn btn-outline" style="cursor:pointer">
            Importar .txt / .csv
            <input type="file" id="mn-file" accept=".txt,.csv,text/plain,text/csv" style="display:none">
          </label>
          <span id="mn-fname" style="font-size:.82rem;color:var(--muted)"></span>
          <button id="mn-add-btn" class="btn btn-primary" style="margin-left:auto">Adicionar ao banco</button>
        </div>
        <div id="mn-add-result" style="margin-top:10px"></div>
      </div>`;
  }

  function renderMiningList() {
    if (!miningData) return `<div class="ed-loading">Carregando…</div>`;
    const { items, total, page, limit } = miningData;
    const editorias = ['', ...Object.keys(EDITORIA_LABEL)];
    return `
      <div class="ed-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <div class="ed-card-title">Banco (${total} itens)</div>
          <button id="mn-label-btn" class="btn btn-outline" style="padding:5px 12px;font-size:.82rem">Etiquetar (IA)</button>
        </div>
        <div class="ed-posts-filters" style="margin-bottom:12px">
          <select id="mn-f-type" class="input" style="width:175px">
            <option value="">Todos tipos</option>
            ${Object.entries(MINING_LABEL).map(([v,l]) => `<option value="${v}" ${miningFilter.type===v?'selected':''}>${l}</option>`).join('')}
          </select>
          <select id="mn-f-status" class="input" style="width:130px">
            <option value="">Todos status</option>
            ${Object.entries(STATUS_LABEL).map(([v,l]) => `<option value="${v}" ${miningFilter.status===v?'selected':''}>${l}</option>`).join('')}
          </select>
          <select id="mn-f-ed" class="input" style="width:200px">
            <option value="">Todas editorias</option>
            ${editorias.filter(Boolean).map(e => `<option value="${e}" ${miningFilter.editoria_provavel===e?'selected':''}>${EDITORIA_LABEL[e]||e}</option>`).join('')}
          </select>
          <label style="display:flex;align-items:center;gap:5px;font-size:.86rem">
            <input type="checkbox" id="mn-f-hook" ${miningFilter.hook_potencial?'checked':''}> Só hooks
          </label>
        </div>

        ${items.length === 0
          ? `<div class="ed-hint" style="padding:20px 0;text-align:center">Nenhum item encontrado.</div>`
          : `<div class="mn-grid">
            ${items.map(item => {
              const tColor = MINING_COLOR[item.type] || 'var(--muted)';
              const sColor = STATUS_COLOR[item.status] || 'var(--muted)';
              return `<div class="mn-item" data-id="${item.id}">
                <div class="mn-item-header">
                  <span class="ed-badge" style="background:${tColor}18;color:${tColor}">${MINING_LABEL[item.type]||item.type}</span>
                  <span class="ed-badge" style="background:${sColor}18;color:${sColor}">${STATUS_LABEL[item.status]||item.status}</span>
                  ${item.hook_potencial ? '<span title="Hook potencial" style="color:var(--terracota);font-size:.9rem">⚡</span>' : ''}
                  <button class="mn-btn-arch" data-id="${item.id}" title="Arquivar" style="margin-left:auto;background:none;border:none;cursor:pointer;color:var(--muted);font-size:.9rem">✕</button>
                </div>
                <div class="mn-content">${safeHtml(item.content)}</div>
                ${item.tema || item.dor ? `
                  <div class="mn-tags">
                    ${item.tema ? `<span class="mn-tag">🏷 ${safeHtml(item.tema)}</span>` : ''}
                    ${item.dor  ? `<span class="mn-tag">💬 ${safeHtml(item.dor)}</span>`  : ''}
                    ${item.editoria_provavel ? `<span class="mn-tag" style="color:${EDITORIA_COLOR[item.editoria_provavel]||'var(--muted)'}">${EDITORIA_LABEL[item.editoria_provavel]||item.editoria_provavel}</span>` : ''}
                  </div>` : ''}
                ${item.source_url ? `<a href="${safeHtml(item.source_url)}" target="_blank" class="mn-source">↗ fonte</a>` : ''}
                <div class="mn-status-row">
                  <select class="mn-status-sel" data-id="${item.id}" style="font-size:.76rem;border:1px solid var(--bege-dark);border-radius:4px;padding:2px 4px;background:white">
                    ${Object.entries(STATUS_LABEL).map(([v,l]) => `<option value="${v}" ${item.status===v?'selected':''}>${l}</option>`).join('')}
                  </select>
                </div>
              </div>`;
            }).join('')}
          </div>`
        }
        <div class="ed-pagination" style="margin-top:14px">
          ${page > 1 ? `<button class="btn btn-outline mn-page-btn" data-page="${page-1}">← Anterior</button>` : ''}
          ${items.length === limit ? `<button class="btn btn-outline mn-page-btn" data-page="${page+1}">Próxima →</button>` : ''}
        </div>
      </div>`;
  }

  function renderMiningTab() {
    return `<div class="ed-section">${renderMiningAdd()}<div id="mn-list">${renderMiningList()}</div></div>`;
  }

  function bindMining() {
    // File import
    el.querySelector('#mn-file')?.addEventListener('change', async e => {
      const f = e.target.files[0];
      if (!f) return;
      el.querySelector('#mn-fname').textContent = f.name;
      el.querySelector('#mn-text').value = await f.text();
    });

    // Adicionar em lote
    el.querySelector('#mn-add-btn')?.addEventListener('click', async () => {
      const text = el.querySelector('#mn-text').value.trim();
      if (!text) { toast('Digite ou importe pelo menos um item', 'error'); return; }
      const type       = el.querySelector('#mn-type').value;
      const source_url = el.querySelector('#mn-source').value.trim() || undefined;
      const expires_at = el.querySelector('#mn-expires').value || undefined;
      const btn = el.querySelector('#mn-add-btn');
      btn.disabled = true; btn.textContent = 'Adicionando…';
      const resultDiv = el.querySelector('#mn-add-result');
      try {
        const d = await api('POST', '/editorial/mining', { type, text, source_url, expires_at });
        resultDiv.innerHTML = `<div class="ed-result-box ed-result-ok">
          <strong>${d.inserted}</strong> inseridos · <strong>${d.duplicates}</strong> duplicatas ignoradas
        </div>`;
        el.querySelector('#mn-text').value = '';
        el.querySelector('#mn-fname').textContent = '';
        toast(`${d.inserted} itens adicionados!`);
        miningData = null;
        await loadMining();
        el.querySelector('#mn-list').innerHTML = renderMiningList();
        bindMiningList();
      } catch (err) {
        resultDiv.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(err.message)}</div>`;
        toast(err.message, 'error');
      } finally { btn.disabled = false; btn.textContent = 'Adicionar ao banco'; }
    });

    bindMiningList();
  }

  function bindMiningList() {
    // Filtros
    el.querySelector('#mn-f-type')?.addEventListener('change', e => { miningFilter.type = e.target.value; miningPage = 1; reloadMiningList(); });
    el.querySelector('#mn-f-status')?.addEventListener('change', e => { miningFilter.status = e.target.value; miningPage = 1; reloadMiningList(); });
    el.querySelector('#mn-f-ed')?.addEventListener('change', e => { miningFilter.editoria_provavel = e.target.value; miningPage = 1; reloadMiningList(); });
    el.querySelector('#mn-f-hook')?.addEventListener('change', e => { miningFilter.hook_potencial = e.target.checked ? 'true' : ''; miningPage = 1; reloadMiningList(); });

    // Etiquetar
    el.querySelector('#mn-label-btn')?.addEventListener('click', async () => {
      const btn = el.querySelector('#mn-label-btn');
      btn.disabled = true; btn.textContent = 'Etiquetando…';
      try {
        const d = await api('POST', '/editorial/mining/label', { limit: 300 });
        toast(`${d.labeled} itens etiquetados!`);
        if (d.errors?.length) toast(d.errors[0], 'error');
        miningData = null; await reloadMiningList();
      } catch (err) { toast(err.message, 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Etiquetar (IA)'; }
    });

    // Status inline
    el.querySelectorAll('.mn-status-sel').forEach(sel => {
      sel.addEventListener('change', async () => {
        const id = sel.dataset.id; const status = sel.value;
        try { await api('PATCH', `/editorial/mining/${id}`, { status }); toast('Status salvo!'); }
        catch (err) { toast(err.message, 'error'); }
      });
    });

    // Arquivar (botão ✕)
    el.querySelectorAll('.mn-btn-arch').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        try {
          await api('DELETE', `/editorial/mining/${id}`);
          btn.closest('.mn-item').style.opacity = '0.3';
          toast('Item arquivado.');
          setTimeout(() => { miningData = null; reloadMiningList(); }, 800);
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    // Paginação
    el.querySelectorAll('.mn-page-btn').forEach(btn => {
      btn.addEventListener('click', () => { miningPage = parseInt(btn.dataset.page, 10); reloadMiningList(); });
    });
  }

  async function reloadMiningList() {
    const listEl = el.querySelector('#mn-list');
    if (listEl) listEl.innerHTML = '<div class="ed-loading">Carregando…</div>';
    try { await loadMining(); if (listEl) { listEl.innerHTML = renderMiningList(); bindMiningList(); } }
    catch (err) { if (listEl) listEl.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(err.message)}</div>`; }
  }

  // ── Tab: Radar ──────────────────────────────────────
  const SCORE_COLOR = s => s >= 8 ? 'var(--verde)' : s >= 6 ? 'var(--terracota)' : 'var(--muted)';

  function renderRadar(temas) {
    const byStatus = { pendente: [], aprovado: [], descartado: [] };
    (temas || []).forEach(t => { (byStatus[t.status] || byStatus.pendente).push(t); });

    const card = t => `
      <div class="rd-card ${t.status}" data-id="${t.id}">
        <div class="rd-header">
          <div class="rd-score" style="color:${SCORE_COLOR(t.score_aderencia)}">${t.score_aderencia}/10</div>
          <div class="rd-editoria">${EDITORIA_LABEL[t.editoria_sugerida] || t.editoria_sugerida || '?'}</div>
          <div class="rd-date">${t.data_coleta ? new Date(t.data_coleta).toLocaleDateString('pt-BR') : ''}</div>
          ${t.expires_at && new Date(t.expires_at) < new Date() ? '<span class="rd-expired">Expirado</span>' : ''}
        </div>
        <div class="rd-tema">${safeHtml(t.tema)}</div>
        <div class="rd-resumo">${safeHtml(t.resumo || '')}</div>
        ${t.score_justificativa ? `<div class="rd-just">${safeHtml(t.score_justificativa)}</div>` : ''}
        ${t.fonte_url ? `<a href="${safeHtml(t.fonte_url)}" target="_blank" class="mn-source">↗ fonte</a>` : ''}
        ${t.status === 'pendente' ? `
          <div class="rd-actions">
            <button class="btn btn-primary rd-aprovar" data-id="${t.id}" style="padding:4px 12px;font-size:.8rem">✓ Aprovar</button>
            <button class="btn btn-outline rd-descartar" data-id="${t.id}" style="padding:4px 12px;font-size:.8rem">✕ Descartar</button>
          </div>` : ''}
      </div>`;

    return `
      <div class="ed-section">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
          <h3 class="ed-section-title" style="margin:0">Radar de Temas</h3>
          <button id="rd-run-btn" class="btn btn-primary" style="padding:6px 14px;font-size:.85rem">▶ Rodar radar (IA + web)</button>
          <span style="font-size:.8rem;color:var(--muted)">${temas.length} temas · validade 14 dias</span>
        </div>
        <div id="rd-run-result"></div>

        ${byStatus.aprovado.length ? `
          <div class="rd-section-label" style="color:var(--verde)">✓ Aprovados (${byStatus.aprovado.length})</div>
          <div class="rd-grid">${byStatus.aprovado.map(card).join('')}</div>` : ''}

        ${byStatus.pendente.length ? `
          <div class="rd-section-label" style="margin-top:16px">⏳ Pendentes (${byStatus.pendente.length})</div>
          <div class="rd-grid">${byStatus.pendente.map(card).join('')}</div>` : ''}

        ${byStatus.descartado.length ? `
          <details style="margin-top:16px">
            <summary style="cursor:pointer;font-size:.85rem;color:var(--muted)">Descartados (${byStatus.descartado.length})</summary>
            <div class="rd-grid" style="margin-top:8px;opacity:.6">${byStatus.descartado.map(card).join('')}</div>
          </details>` : ''}

        ${!temas.length ? `<div class="ed-hint" style="text-align:center;padding:40px 0">Nenhum tema ainda. Clique em "Rodar radar" para buscar.</div>` : ''}
      </div>`;
  }

  function bindRadar() {
    el.querySelector('#rd-run-btn')?.addEventListener('click', async () => {
      const btn = el.querySelector('#rd-run-btn');
      const res = el.querySelector('#rd-run-result');
      btn.disabled = true; btn.textContent = '⏳ Pesquisando (~60s)…';
      res.innerHTML = '<div class="ed-result-box">Radar rodando em segundo plano… pode levar até ~90s.</div>';
      try {
        // Inicia job async — devolve job_id na hora (não trava no proxy)
        const { job_id } = await api('POST', '/editorial/radar/run', {});
        if (!job_id) throw new Error('Falha ao iniciar o radar');

        // Polling do status (a cada 3s, teto de 3min)
        const started = Date.now();
        const poll = async () => {
          let st;
          try { st = await api('GET', `/editorial/radar/status/${job_id}`); }
          catch (err) { res.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(err.message)}</div>`; btn.disabled = false; btn.textContent = '▶ Rodar radar (IA + web)'; return; }

          if (st.status === 'processing') {
            if (Date.now() - started > 180_000) {
              res.innerHTML = `<div class="ed-result-box ed-result-err">Radar demorou demais. Tente novamente.</div>`;
              btn.disabled = false; btn.textContent = '▶ Rodar radar (IA + web)';
              return;
            }
            return setTimeout(poll, 3000);
          }

          if (st.status === 'error') {
            res.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(st.error || 'Erro no radar')}</div>`;
            btn.disabled = false; btn.textContent = '▶ Rodar radar (IA + web)';
            return;
          }

          // done
          btn.disabled = false; btn.textContent = '▶ Rodar radar (IA + web)';
          const n = st.temas?.length || 0;
          const errDetail = (st.errors?.length)
            ? `<div class="ed-warnings">${st.errors.map(e => `<div>⚠ ${safeHtml(e.query || '')}: ${safeHtml(e.error || JSON.stringify(e))}</div>`).join('')}</div>`
            : '';

          if (n > 0) {
            // Há temas novos → re-renderiza a seção. Erros (se houver) viram toast.
            toast(`${n} temas adicionados!${st.errors?.length ? ` (${st.errors.length} falharam)` : ''}`);
            const fresh = await api('GET', '/editorial/radar');
            el.querySelector('.ed-section').outerHTML = renderRadar(fresh);
            bindRadar();
          } else {
            // Zero temas → NÃO re-renderiza (senão apaga o detalhe do erro). Mantém visível.
            res.innerHTML = `<div class="ed-result-box ed-result-err">Radar não retornou temas${st.errors?.length ? ` · ${st.errors.length} erro(s)` : ''}${errDetail}</div>`;
            toast('Radar não retornou temas — veja o detalhe abaixo', 'error');
          }
        };
        setTimeout(poll, 3000);
      } catch (err) {
        res.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(err.message)}</div>`;
        toast(err.message, 'error');
        btn.disabled = false; btn.textContent = '▶ Rodar radar (IA + web)';
      }
    });

    el.querySelectorAll('.rd-aprovar').forEach(btn => {
      btn.addEventListener('click', async () => {
        try { await api('PATCH', `/editorial/radar/${btn.dataset.id}`, { status: 'aprovado' }); btn.closest('.rd-card').classList.replace('pendente','aprovado'); btn.closest('.rd-actions').remove(); toast('Tema aprovado!'); }
        catch (err) { toast(err.message, 'error'); }
      });
    });
    el.querySelectorAll('.rd-descartar').forEach(btn => {
      btn.addEventListener('click', async () => {
        try { await api('PATCH', `/editorial/radar/${btn.dataset.id}`, { status: 'descartado' }); btn.closest('.rd-card').style.opacity = '.3'; toast('Descartado.'); }
        catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  // ── Tab: Semana (wizard gamificado) ─────────────────
  const FASE_LABEL = ['', 'Mineração', 'Pauta', 'Roteiros', 'Gravação', 'Leitura'];
  const FASE_DESC  = ['',
    'Subir CSV, revisar classificações, colar frases no banco, confirmar radar.',
    'Aprovar ou trocar os 4 slots da semana.',
    'Gerar, editar e aprovar roteiros para cada slot.',
    'Gravar com a Evelyn. Checar itens da sessão.',
    'Ler os números, declarar reencarnações, registrar hipótese.',
  ];
  const METRICA_LABEL = { envio:'Envios', seguidor:'Seguidores', salvamento:'Salvamentos', comentario:'Comentários', clique_bio:'Clique bio' };
  const STATUS_ROTEIRO_LABEL = { rascunho:'Rascunho', aprovado:'Aprovado ✓', gravado:'Gravado', publicado:'Publicado', lido:'Lido' };

  function flagChip(f) {
    const cor = f.nivel === 'vermelho' ? '#c62828' : f.nivel === 'amarelo' ? '#e65100' : 'var(--verde)';
    const icon = f.nivel === 'vermelho' ? '🔴' : f.nivel === 'amarelo' ? '🟡' : '🟢';
    return `<span class="rd-flag" style="border-color:${cor};color:${cor}" title="${safeHtml(f.trecho)}">${icon} ${safeHtml(f.regra)}</span>`;
  }

  function renderSemana(data) {
    const { semana, pautas = [], roteiros_por_pauta = {}, streak = 0, placar = {} } = data;
    const fase = semana?.fase || 1;
    const ini  = semana?.semana_inicio ? new Date(semana.semana_inicio).toLocaleDateString('pt-BR') : '—';
    const fim  = semana?.semana_fim    ? new Date(semana.semana_fim).toLocaleDateString('pt-BR')    : '—';

    // Barra de progresso geral
    const progPct = Math.round(((fase - 1) / 5) * 100);

    // Streak badge
    const streakHtml = streak > 0
      ? `<span class="sem-streak">🔥 ${streak} semana${streak !== 1 ? 's' : ''} seguida${streak !== 1 ? 's' : ''}</span>`
      : '';

    // Placar
    const placarHtml = placar.total > 0
      ? `<span class="sem-placar">${placar.no_alvo}/${placar.total} no alvo</span>`
      : '';

    // Fases
    const fasesHtml = [1,2,3,4,5].map(f => {
      const ativa   = f === fase;
      const concl   = f < fase;
      const futura  = f > fase;
      return `
        <div class="sem-fase ${ativa ? 'ativa' : concl ? 'concluida' : 'futura'}" data-fase="${f}">
          <div class="sem-fase-num">${concl ? '✓' : f}</div>
          <div class="sem-fase-info">
            <div class="sem-fase-label">${FASE_LABEL[f]}</div>
            ${ativa ? `<div class="sem-fase-desc">${FASE_DESC[f]}</div>` : ''}
          </div>
        </div>`;
    }).join('');

    // Conteúdo da fase atual
    let faseContent = '';

    if (fase === 1) {
      faseContent = `
        <div class="sem-fase-body">
          <h4>Checklist de Mineração</h4>
          <div class="sem-checklist">
            <label><input type="checkbox" id="chk-csv"> CSV da semana importado (ou confirmado que não há novo)</label>
            <label><input type="checkbox" id="chk-class"> Classificações revisadas</label>
            <label><input type="checkbox" id="chk-frases"> Frases da semana adicionadas ao banco</label>
            <label><input type="checkbox" id="chk-radar"> Radar revisado</label>
          </div>
          <button id="sem-avancar-btn" class="btn btn-primary" style="margin-top:16px" disabled>Avançar para Pauta →</button>
        </div>`;
    } else if (fase === 2) {
      const slotsHtml = pautas.length === 0
        ? `<div style="margin-bottom:12px"><button id="sem-gerar-pauta" class="btn btn-primary">Gerar pauta com IA</button></div>`
        : pautas.map(p => `
          <div class="sem-slot ${p.status}" data-id="${p.id}">
            <div class="sem-slot-dia">${p.slot_dia}</div>
            <div class="sem-slot-body">
              <div class="sem-slot-ed">${EDITORIA_LABEL[p.editoria] || p.editoria}</div>
              <div class="sem-slot-tese">${safeHtml(p.frase_tese || '')}</div>
              <div class="sem-slot-meta">Meta: <strong>${METRICA_LABEL[p.metrica_alvo] || p.metrica_alvo}</strong> · ${p.formato || ''}</div>
            </div>
            <div class="sem-slot-actions">
              ${p.status === 'proposto' ? `
                <button class="btn btn-primary slt-aceitar" data-id="${p.id}" style="padding:4px 10px;font-size:.8rem">✓ Aceitar</button>
                <button class="btn btn-outline slt-alternativa" data-id="${p.id}" style="padding:4px 10px;font-size:.8rem">↺ Alternativa</button>` : ''}
              ${p.status === 'aceito' ? '<span style="color:var(--verde);font-size:.85rem">✓ Aceito</span>' : ''}
            </div>
          </div>`).join('');

      const todosAceitos = pautas.length > 0 && pautas.every(p => p.status === 'aceito');
      faseContent = `
        <div class="sem-fase-body">
          <h4>Pauta da Semana</h4>
          <div id="sem-slots-wrap">${slotsHtml}</div>
          <div id="sem-pauta-result"></div>
          ${todosAceitos ? `<button id="sem-avancar-btn" class="btn btn-primary" style="margin-top:12px">Avançar para Roteiros →</button>` : ''}
        </div>`;
    } else if (fase === 3) {
      const roteirosHtml = pautas.map(p => {
        const rots = roteiros_por_pauta[p.id] || [];
        const temAprovado = rots.some(r => r.status === 'aprovado');
        return `
          <div class="sem-pauta-rot" data-pauta="${p.id}">
            <div class="sem-slot-dia">${p.slot_dia}</div>
            <div style="flex:1">
              <div class="sem-slot-ed">${EDITORIA_LABEL[p.editoria] || p.editoria} · ${p.formato || ''}</div>
              <div class="sem-slot-tese">${safeHtml(p.frase_tese || '')}</div>
              ${rots.length === 0
                ? `<button class="btn btn-outline rot-gerar" data-pauta="${p.id}" style="margin-top:8px;padding:4px 12px;font-size:.82rem">Gerar 2 roteiros (IA)</button>`
                : rots.map(r => {
                    const temVerm = (r.flags || []).some(f => f.nivel === 'vermelho');
                    return `
                      <div class="rot-card ${r.status}" data-rot="${r.id}">
                        <div class="rot-header">
                          <span class="rot-var">Variação ${r.variacao}</span>
                          <select class="rot-status-sel" data-id="${r.id}" ${temVerm && r.status !== 'aprovado' ? 'title="Tem flag vermelha — corrija antes de aprovar"' : ''}>
                            ${Object.entries(STATUS_ROTEIRO_LABEL).map(([v,l]) =>
                              `<option value="${v}" ${r.status===v?'selected':''} ${v==='aprovado'&&temVerm?'disabled':''}>
                                ${l}${v==='aprovado'&&temVerm?' (bloqueado 🔴)':''}
                              </option>`
                            ).join('')}
                          </select>
                        </div>
                        <div class="rot-flags">${(r.flags||[]).map(flagChip).join('')}</div>
                        <div class="rot-hook"><strong>Hook:</strong> ${safeHtml(r.hook||'')}</div>
                        <div class="rot-virada"><strong>Virada:</strong> <em>${safeHtml(r.frase_do_post||'')}</em></div>
                        <details class="rot-details">
                          <summary>Ver roteiro completo</summary>
                          <pre class="rot-full">${safeHtml(r.full_content||'')}</pre>
                        </details>
                        <div style="margin-top:8px;display:flex;gap:6px">
                          <button class="btn btn-outline rot-edit-btn" data-id="${r.id}" style="padding:3px 10px;font-size:.78rem">Editar</button>
                          <button class="btn btn-outline rot-export-btn" data-id="${r.id}" style="padding:3px 10px;font-size:.78rem">↓ Exportar</button>
                        </div>
                      </div>`;
                  }).join('')
              }
            </div>
          </div>`;
      }).join('');

      const todosAprovados = pautas.length > 0 && pautas.every(p => (roteiros_por_pauta[p.id]||[]).some(r => r.status === 'aprovado'));
      faseContent = `
        <div class="sem-fase-body">
          <h4>Roteiros</h4>
          <div id="sem-rot-wrap">${roteirosHtml}</div>
          <div id="sem-rot-result"></div>
          ${todosAprovados ? `<button id="sem-avancar-btn" class="btn btn-primary" style="margin-top:12px">Avançar para Gravação →</button>` : ''}
        </div>`;
    } else if (fase === 4) {
      const gravacaoItems = pautas.map(p => {
        const rotAprovado = (roteiros_por_pauta[p.id]||[]).find(r => r.status === 'aprovado');
        return `
          <div class="sem-grav-item">
            <input type="checkbox" class="grav-chk" data-pauta="${p.id}" ${(semana?.estado?.fase4?.gravados||[]).includes(String(p.id)) ? 'checked' : ''}>
            <div>
              <strong>${p.slot_dia} — ${EDITORIA_LABEL[p.editoria]||p.editoria}</strong>
              ${rotAprovado ? `<div style="font-size:.82rem;color:var(--muted);margin-top:3px">Hook: ${safeHtml((rotAprovado.hook||'').slice(0,80))}</div>` : ''}
            </div>
          </div>`;
      }).join('');

      faseContent = `
        <div class="sem-fase-body">
          <h4>Sessão de Gravação</h4>
          <p class="ed-hint">Check quando gravar. Lembre de b-roll + hooks extras para semana seguinte.</p>
          <div class="sem-grav-list" id="grav-list">${gravacaoItems}</div>
          <button id="sem-avancar-btn" class="btn btn-primary" style="margin-top:16px">Avançar para Leitura →</button>
        </div>`;
    } else if (fase === 5) {
      faseContent = `
        <div class="sem-fase-body">
          <h4>Leitura da Semana</h4>
          <p class="ed-hint">Compare realizado vs meta. Declare reencarnações. Registre 1 hipótese.</p>
          <div class="sem-leitura">
            ${pautas.map(p => `
              <div class="sem-leit-slot">
                <div class="sem-slot-dia">${p.slot_dia}</div>
                <div>
                  <div class="sem-slot-ed">${EDITORIA_LABEL[p.editoria]||p.editoria} · meta: <strong>${METRICA_LABEL[p.metrica_alvo]||p.metrica_alvo}</strong></div>
                  <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:.85rem">
                    <input type="checkbox" class="leit-alvo-chk" data-pauta="${p.id}"> Atingiu a meta
                  </label>
                  <label style="display:flex;align-items:center;gap:6px;margin-top:4px;font-size:.85rem">
                    <input type="checkbox" class="leit-reenc-chk" data-pauta="${p.id}"> Reencarnar este post
                  </label>
                </div>
              </div>`).join('')}
          </div>
          <div style="margin-top:16px">
            <label class="ed-hint">Hipótese nova para próxima semana (máx 1):</label>
            <textarea id="leit-hipotese" class="ed-textarea" rows="2" style="margin-top:6px">${safeHtml(semana?.estado?.fase5?.hipotese||'')}</textarea>
          </div>
          <button id="sem-fechar-btn" class="btn btn-primary" style="margin-top:12px">Fechar semana ✓</button>
        </div>`;
    }

    return `
      <div class="ed-section">
        <div class="sem-top">
          <div>
            <h3 class="ed-section-title">Semana ${ini} – ${fim}</h3>
            <div style="display:flex;gap:10px;margin-top:4px">${streakHtml}${placarHtml}</div>
          </div>
          <button id="sem-seed-btn" class="btn btn-outline" style="font-size:.78rem;padding:4px 10px" title="Popular com dados de exemplo">Seed exemplo</button>
        </div>

        <div class="sem-progress-bar"><div style="width:${progPct}%;background:var(--verde);height:100%;border-radius:4px;transition:width .4s"></div></div>
        <div class="sem-fases">${fasesHtml}</div>

        <div id="sem-fase-content">${faseContent}</div>
      </div>`;
  }

  function bindSemana(data) {
    const { semana, pautas = [] } = data;
    const semanaId = semana?.id;

    // Seed
    el.querySelector('#sem-seed-btn')?.addEventListener('click', async () => {
      if (!confirm('Popular banco com dados de exemplo? Só insere se banco estiver vazio.')) return;
      try { const d = await api('POST', '/editorial/seed', {}); toast(d.seeded ? 'Seed feito!' : d.reason); }
      catch (err) { toast(err.message, 'error'); }
    });

    // Fase 1: checklist
    const chks = ['chk-csv','chk-class','chk-frases','chk-radar'];
    function checkFase1() {
      const btn = el.querySelector('#sem-avancar-btn');
      if (btn) btn.disabled = !chks.every(id => el.querySelector(`#${id}`)?.checked);
    }
    chks.forEach(id => el.querySelector(`#${id}`)?.addEventListener('change', checkFase1));

    // Avançar fase genérico
    el.querySelector('#sem-avancar-btn')?.addEventListener('click', async () => {
      const btn = el.querySelector('#sem-avancar-btn');
      btn.disabled = true; btn.textContent = 'Avançando…';
      try {
        await api('POST', '/editorial/semana/avancar', { dados: {} });
        toast('Fase avançada!');
        const fresh = await api('GET', '/editorial/semana');
        el.querySelector('.ed-section').outerHTML = renderSemana(fresh);
        bindSemana(fresh);
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Avançar →'; }
    });

    // Fase 2: gerar pauta
    el.querySelector('#sem-gerar-pauta')?.addEventListener('click', async () => {
      const btn = el.querySelector('#sem-gerar-pauta');
      btn.disabled = true; btn.textContent = 'Gerando pauta (IA)…';
      try {
        await api('POST', '/editorial/pautas/gerar', { semana_id: semanaId });
        toast('Pauta gerada!');
        const fresh = await api('GET', '/editorial/semana');
        el.querySelector('.ed-section').outerHTML = renderSemana(fresh);
        bindSemana(fresh);
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Gerar pauta com IA'; }
    });

    // Fase 2: aceitar/trocar slot
    el.querySelectorAll('.slt-aceitar').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api('PATCH', `/editorial/pautas/${btn.dataset.id}`, { status: 'aceito' });
          btn.closest('.sem-slot').classList.replace('proposto','aceito');
          btn.closest('.sem-slot-actions').innerHTML = '<span style="color:var(--verde);font-size:.85rem">✓ Aceito</span>';
          // check if all accepted
          const slots = el.querySelectorAll('.sem-slot');
          const allAceito = [...slots].every(s => s.classList.contains('aceito'));
          if (allAceito && !el.querySelector('#sem-avancar-btn')) {
            el.querySelector('#sem-slots-wrap').insertAdjacentHTML('afterend',
              '<button id="sem-avancar-btn" class="btn btn-primary" style="margin-top:12px">Avançar para Roteiros →</button>');
            el.querySelector('#sem-avancar-btn').addEventListener('click', async () => {
              await api('POST', '/editorial/semana/avancar', { dados: {} });
              toast('Avançando!');
              const fresh = await api('GET', '/editorial/semana');
              el.querySelector('.ed-section').outerHTML = renderSemana(fresh);
              bindSemana(fresh);
            });
          }
          toast('Slot aceito!');
        } catch (err) { toast(err.message, 'error'); }
      });
    });
    el.querySelectorAll('.slt-alternativa').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '↺ Gerando…';
        try {
          // Re-gerar pauta completa; por ora remove todos e gera novo
          await api('POST', '/editorial/pautas/gerar', { semana_id: semanaId, forcar: true });
          toast('Nova sugestão gerada!');
          const fresh = await api('GET', '/editorial/semana');
          el.querySelector('.ed-section').outerHTML = renderSemana(fresh);
          bindSemana(fresh);
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = '↺ Alternativa'; }
      });
    });

    // Fase 3: gerar roteiros por slot
    el.querySelectorAll('.rot-gerar').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pautaId = btn.dataset.pauta;
        btn.disabled = true; btn.textContent = 'Gerando (~30s)…';
        const res = el.querySelector('#sem-rot-result');
        try {
          await api('POST', `/editorial/pautas/${pautaId}/roteiros`, {});
          toast('Roteiros gerados!');
          const fresh = await api('GET', '/editorial/semana');
          el.querySelector('.ed-section').outerHTML = renderSemana(fresh);
          bindSemana(fresh);
        } catch (err) {
          res.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(err.message)}</div>`;
          toast(err.message, 'error');
          btn.disabled = false; btn.textContent = 'Gerar 2 roteiros (IA)';
        }
      });
    });

    // Fase 3: status roteiro
    el.querySelectorAll('.rot-status-sel').forEach(sel => {
      sel.addEventListener('change', async () => {
        try {
          await api('PATCH', `/editorial/roteiros/${sel.dataset.id}`, { status: sel.value });
          toast('Status salvo!');
          if (sel.value === 'aprovado') {
            sel.closest('.rot-card').classList.add('aprovado');
            // re-render to check if all approved
            const fresh = await api('GET', '/editorial/semana');
            el.querySelector('.ed-section').outerHTML = renderSemana(fresh);
            bindSemana(fresh);
          }
        } catch (err) { toast(err.message, 'error'); sel.value = sel.dataset.prev || 'rascunho'; }
      });
      sel.dataset.prev = sel.value;
    });

    // Fase 3: exportar roteiro
    el.querySelectorAll('.rot-export-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/editorial/roteiros/' + btn.dataset.id + '/export', {
            headers: { Authorization: 'Bearer ' + state.token }
          });
          const text = await res.text();
          const blob = new Blob([text], { type: 'text/plain' });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href = url; a.download = `roteiro_${btn.dataset.id}.txt`; a.click();
          URL.revokeObjectURL(url);
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    // Fase 4: gravação checklist
    el.querySelectorAll('.grav-chk').forEach(chk => {
      chk.addEventListener('change', async () => {
        const gravados = [...el.querySelectorAll('.grav-chk:checked')].map(c => c.dataset.pauta);
        try { await api('POST', '/editorial/semana/avancar', { dados: { fase4: { gravados } } }); }
        catch (err) { toast(err.message, 'error'); }
      });
    });

    // Fase 5: fechar semana
    el.querySelector('#sem-fechar-btn')?.addEventListener('click', async () => {
      const hipotese = el.querySelector('#leit-hipotese')?.value || '';
      const noAlvo   = [...el.querySelectorAll('.leit-alvo-chk:checked')].map(c => c.dataset.pauta);
      const reenc    = [...el.querySelectorAll('.leit-reenc-chk:checked')].map(c => c.dataset.pauta);
      const btn = el.querySelector('#sem-fechar-btn');
      btn.disabled = true; btn.textContent = 'Fechando…';
      try {
        await api('POST', '/editorial/semana/avancar', { dados: { fase5: { hipotese, no_alvo: noAlvo, reencarnacoes: reenc, leitura_feita: true } } });
        toast('Semana fechada! 🎉');
        const fresh = await api('GET', '/editorial/semana');
        el.querySelector('.ed-section').outerHTML = renderSemana(fresh);
        bindSemana(fresh);
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Fechar semana ✓'; }
    });
  }

  // ── Render principal ────────────────────────────────
  async function render() {
    el.innerHTML = `
      <div class="ed-page">
        <div class="ed-header">
          <h2 class="ed-page-title">Editorial Engine <span style="color:var(--terracota)">@nutrievelynliu</span></h2>
          <button id="ed-refresh" class="btn btn-outline" style="padding:6px 14px;font-size:.82rem">↺ Atualizar</button>
        </div>
        ${renderTabs()}
        <div id="ed-tab-content">
          ${activeTab === 'upload' ? renderUpload() : '<div class="ed-loading">Carregando…</div>'}
        </div>
      </div>`;

    bindTabs();

    el.querySelector('#ed-refresh')?.addEventListener('click', () => {
      analyticsData = null; postsData = null; render();
    });

    const tabContent = el.querySelector('#ed-tab-content');

    if (activeTab === 'upload') {
      bindUpload();
    } else if (activeTab === 'posts') {
      try {
        if (!postsData) await loadPosts();
        tabContent.innerHTML = renderPostsTab();
        bindPosts();
      } catch (err) {
        tabContent.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(err.message)}</div>`;
      }
    } else if (activeTab === 'mining') {
      tabContent.innerHTML = renderMiningTab();
      try {
        if (!miningData) await loadMining();
        el.querySelector('#mn-list').innerHTML = renderMiningList();
      } catch (err) {
        el.querySelector('#mn-list').innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(err.message)}</div>`;
      }
      bindMining();
    } else if (activeTab === 'radar') {
      try {
        tabContent.innerHTML = '<div class="ed-loading">Carregando radar…</div>';
        const data = await api('GET', '/editorial/radar');
        tabContent.innerHTML = renderRadar(data);
        bindRadar();
      } catch (err) {
        tabContent.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(err.message)}</div>`;
      }
    } else if (activeTab === 'semana') {
      try {
        tabContent.innerHTML = '<div class="ed-loading">Carregando semana…</div>';
        const data = await api('GET', '/editorial/semana');
        tabContent.innerHTML = renderSemana(data);
        bindSemana(data);
      } catch (err) {
        tabContent.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(err.message)}</div>`;
      }
    } else {
      try {
        if (!analyticsData) await loadAnalytics();
        tabContent.innerHTML = renderDashboard();
        bindDashboard();
      } catch (err) {
        tabContent.innerHTML = `<div class="ed-result-box ed-result-err">${safeHtml(err.message)}</div>`;
      }
    }
  }

  await render();
}

// ── Boot ───────────────────────────────────────────────
renderApp();

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
  const json = await res.json();
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
const ROLE_MENUS = {
  admin:  ['calendario','gerador','anuncios','repurposing','edicao','mercado','insights','admin'],
  evelyn: ['calendario','gerador','anuncios','repurposing','edicao','mercado','insights'],
  editor: ['calendario','gerador','anuncios','repurposing','edicao','mercado','insights'],
  nutri:  ['gerador','repurposing','edicao'],
};

const MENU_LABELS = {
  calendario:  { icon: '📅', label: 'Calendário' },
  gerador:     { icon: '✨', label: 'Gerador' },
  anuncios:    { icon: '📣', label: 'Anúncios' },
  repurposing: { icon: '♻️', label: 'Repurposing' },
  edicao:      { icon: '🎬', label: 'Edição' },
  mercado:     { icon: '📊', label: 'Mercado' },
  insights:    { icon: '💡', label: 'Insights' },
  admin:       { icon: '⚙️', label: 'Admin' },
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

  document.querySelectorAll('nav a[data-page]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); navigate(a.dataset.page); });
  });

  document.getElementById('logout-btn').addEventListener('click', e => { e.preventDefault(); logout(); });

  navigate(allowedPages[0]);
}

function renderPage() {
  const content = document.getElementById('content');
  const pages = { calendario, gerador, anuncios, repurposing, edicao, mercado, insights, admin };
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
      <div class="calendar-grid">
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
    html += '</div>';
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
      <div class="week-grid">
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
    html += '</div>';
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
      ${card.generated_by_ai ? '<span class="badge" style="background:#f0e8ff;color:#5a2d9a">✨ IA</span>' : ''}
    </div>
    <h2>${safeHtml(card.title)}</h2>
    <p style="color:var(--muted);font-size:.85rem;margin-bottom:16px">
      Responsável: ${card.responsible_name || '—'} · Publicação: ${formatDate(card.publish_date)}
    </p>
    ${card.drive_link ? `<p style="margin-bottom:12px"><a href="${card.drive_link}" target="_blank" style="color:var(--terracota)">🔗 Drive</a></p>` : ''}
    ${card.content ? `<div class="ai-output">${safeHtml(card.content)}</div>` : '<p style="color:var(--muted)">Sem roteiro ainda.</p>'}
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;align-items:center">
      <select id="status-select" style="padding:8px;border:1.5px solid var(--bege-dark);border-radius:6px;font-family:Jost,sans-serif">
        ${['ideia','roteiro','gravado','edicao','programado','publicado'].map(s=>`<option value="${s}"${s===card.status?' selected':''}>${s}</option>`).join('')}
      </select>
      <button class="btn btn-primary btn-sm" id="save-status">Atualizar status</button>
      ${['carrossel','carrossel_video'].includes(card.format) && card.content
        ? `<button class="btn btn-accent btn-sm" id="gen-carousel-btn">🎨 Gerar slides PNG</button>`
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
    btn.textContent = '⏳ Gerando slides...';
    resultEl.innerHTML = '<div class="loading"><div class="spinner"></div> Renderizando slides via Puppeteer...</div>';
    try {
      const data = await api('POST', `/cards/${card.id}/carousel`);
      resultEl.innerHTML = `
        <div style="background:var(--bege);border-radius:8px;padding:14px;display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.9rem">✅ <strong>${data.slides} slides</strong> gerados (1080×1080px, 2×)</span>
          <a href="${encodeURI(data.download_url)}" download class="btn btn-accent btn-sm">⬇ Baixar ZIP</a>
        </div>
      `;
      toast(`${data.slides} slides prontos!`);
    } catch (e) {
      resultEl.innerHTML = `<p style="color:#c0392b;font-size:.85rem">Erro: ${safeHtml(e.message)}</p>`;
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🎨 Gerar slides PNG';
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
            <p style="font-size:.8rem;font-weight:500;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:10px">🎨 Opções de Carrossel</p>

            <div class="form-group" style="margin-bottom:10px">
              <label style="font-size:.85rem">Modo</label>
              <div style="display:flex;gap:8px;margin-top:6px">
                <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer">
                  <input type="radio" name="carousel_mode" value="ai" checked> Gerar roteiro com IA e depois criar PNG
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer">
                  <input type="radio" name="carousel_mode" value="direct"> Já tenho os slides — gerar PNG direto
                </label>
              </div>
            </div>

            <div id="direct-content-field" style="display:none" class="form-group">
              <label style="font-size:.85rem">Conteúdo dos slides</label>
              <textarea id="direct-slides-content" rows="8" style="font-size:.82rem;font-family:monospace" placeholder="SLIDE 1: Título de impacto&#10;&#10;SLIDE 2: Conteúdo do slide&#10;&#10;SLIDE 3: Mais conteúdo&#10;&#10;SLIDE FINAL: CTA"></textarea>
              <p style="font-size:.75rem;color:var(--muted);margin-top:4px">Use SLIDE 1, SLIDE 2... SLIDE FINAL para separar os slides.</p>
            </div>

            <div class="form-group" style="margin-bottom:0">
              <label style="font-size:.85rem">Pasta de fotos no Google Drive <span style="color:var(--muted)">(opcional)</span></label>
              <input type="url" id="drive-folder-url" placeholder="https://drive.google.com/drive/folders/..." style="font-size:.85rem">
              <p style="font-size:.75rem;color:var(--muted);margin-top:4px">As fotos serão usadas como fundo sutil nos slides. Compartilhe a pasta com a service account.</p>
            </div>
          </div>
        </div>

        <button type="submit" class="btn btn-accent btn-full" id="gen-submit-btn">✨ Gerar com IA</button>
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
      submitBtn.textContent = '🎨 Gerar slides PNG';
      directField.style.display = 'block';
      el.querySelector('#gen-briefing').required = false;
    } else {
      submitBtn.textContent = '✨ Gerar com IA';
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
        <button class="btn btn-accent btn-sm" id="inline-carousel-btn">🎨 Gerar slides PNG</button>
        <div id="inline-carousel-result" style="margin-top:10px"></div>
      </div>`;
  }

  function attachCarouselBtn(resultEl, cardId, driveFolderUrl) {
    const btn = resultEl.querySelector('#inline-carousel-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '⏳ Gerando slides...';
      const slideResult = resultEl.querySelector('#inline-carousel-result');
      slideResult.innerHTML = '<div class="loading"><div class="spinner"></div> Renderizando slides via Puppeteer...</div>';
      try {
        const data = await api('POST', `/cards/${cardId}/carousel`, driveFolderUrl ? { drive_folder_url: driveFolderUrl } : undefined);
        slideResult.innerHTML = `
          <div style="background:var(--bege);border-radius:8px;padding:14px;display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:.9rem">✅ <strong>${data.slides} slides</strong> gerados (1080×1080px, 2×)</span>
            <a href="${encodeURI(data.download_url)}" download class="btn btn-accent btn-sm">⬇ Baixar ZIP</a>
          </div>`;
        toast(`${data.slides} slides prontos!`);
      } catch (e) {
        slideResult.innerHTML = `<p style="color:#c0392b;font-size:.85rem">Erro: ${safeHtml(e.message)}</p>`;
        toast(e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '🎨 Gerar slides PNG';
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
      btn.textContent = '⏳ Gerando slides...';
      result.innerHTML = '<div class="loading"><div class="spinner"></div> Renderizando slides via Puppeteer...</div>';
      try {
        const data = await api('POST', '/cards/carousel-direct', { content, drive_folder_url: driveFolderUrl });
        result.innerHTML = `
          <div class="card">
            <div style="background:var(--bege);border-radius:8px;padding:14px;display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:.9rem">✅ <strong>${data.slides} slides</strong> gerados (1080×1080px, 2×)</span>
              <a href="${encodeURI(data.download_url)}" download class="btn btn-accent btn-sm">⬇ Baixar ZIP</a>
            </div>
          </div>`;
        toast(`${data.slides} slides prontos!`);
      } catch (err) {
        result.innerHTML = `<div class="card" style="border-left:4px solid #c0392b"><p style="color:#c0392b">Erro: ${safeHtml(err.message)}</p></div>`;
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '🎨 Gerar slides PNG';
      }
      return;
    }

    // Modo IA (padrão)
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    btn.textContent = '⏳ Gerando...';
    result.innerHTML = '<div class="loading"><div class="spinner"></div> Gerando conteúdo com IA...</div>';
    try {
      const card = await api('POST', '/generate/content', body);
      result.innerHTML = `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <h3 style="font-family:'Cormorant Garamond',serif;color:var(--verde)">Conteúdo gerado</h3>
            <span class="badge" style="background:#f0e8ff;color:#5a2d9a">✨ IA · salvo como roteiro</span>
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
      btn.textContent = isCarousel ? '🎨 Gerar slides PNG' : '✨ Gerar com IA';
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
          <button type="submit" class="btn btn-accent btn-full">📣 Gerar Copies</button>
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
    btn.disabled = true; btn.textContent = '⏳ Gerando...';
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
      btn.disabled = false; btn.textContent = '📣 Gerar Copies';
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
        <button class="btn btn-accent" id="repurpose-btn">♻️ Gerar Repurposing</button>
      </div>
      <div id="repurpose-result"></div>
    </div>
  `;

  el.querySelector('#repurpose-btn').addEventListener('click', async () => {
    const transcricao = el.querySelector('#transcricao').value.trim();
    if (!transcricao) { toast('Cole uma transcrição primeiro', 'error'); return; }
    const btn = el.querySelector('#repurpose-btn');
    btn.disabled = true; btn.textContent = '⏳ Processando...';
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
      btn.disabled = false; btn.textContent = '♻️ Gerar Repurposing';
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
          <label>URL do vídeo (link direto para download — MP4, MOV, WebM)</label>
          <input id="video-url" placeholder="https://seu-bucket.s3.amazonaws.com/video.mp4">
        </div>
        <div class="form-group">
          <label>Instruções em linguagem natural</label>
          <textarea id="video-instructions" rows="5" placeholder="Ex: Remover pausas e silêncios, adicionar legendas, converter para 9:16, reduzir volume para 50%"></textarea>
        </div>
        <button class="btn btn-accent" id="edit-btn">🎬 Editar vídeo</button>
      </div>

      <div class="card" style="background:var(--bege);border:none;box-shadow:none;padding:14px 18px">
        <p style="font-size:.82rem;color:var(--muted);line-height:1.6">
          <strong>Operações suportadas:</strong> corte (trim) · remover pausas/silêncios · legendas automáticas ·
          resize 9:16 / 1:1 / 16:9 · ajuste de velocidade (0.5×–2×) · redução de volume · mudo · preto&amp;branco<br>
          <strong>Formatos de entrada:</strong> MP4, MOV, WebM, AVI, MKV (via URL pública direta)
        </p>
      </div>

      <div id="edit-result" style="margin-top:20px"></div>
    </div>
  `;

  el.querySelector('#edit-btn').addEventListener('click', async () => {
    const video_url = el.querySelector('#video-url').value.trim();
    const instructions = el.querySelector('#video-instructions').value.trim();
    if (!video_url || !instructions) { toast('Preencha URL e instruções', 'error'); return; }
    const btn = el.querySelector('#edit-btn');
    btn.disabled = true; btn.textContent = '⏳ Processando...';
    const result = document.getElementById('edit-result');
    result.innerHTML = '<div class="loading"><div class="spinner"></div> Editando vídeo com FFmpeg… pode levar alguns segundos.</div>';

    try {
      const data = await api('POST', '/edit/video', { video_url, instructions });

      // Ops aplicadas em formato legível
      const ops = data.ops_applied || {};
      const opsList = [
        ops.trim    ? `✂️ Corte: ${ops.trim.start}s → ${ops.trim.end}s` : null,
        ops.resize  ? `📐 Resize: ${ops.resize}` : null,
        ops.speed   ? `⏩ Velocidade: ${ops.speed}×` : null,
        ops.mute    ? `🔇 Áudio removido` : ops.volume !== null ? `🔊 Volume: ${Math.round(ops.volume * 100)}%` : null,
        ops.grayscale ? `🎞 Preto e branco` : null,
        ops.removeSilence ? `✂️ Pausas removidas` : null,
        ops.subtitles ? `💬 Legendas (burned-in)` : null,
        ops.subtitles_warning ? `⚠️ Legendas não aplicadas: ${ops.subtitles_warning}` : null,
      ].filter(Boolean);

      result.innerHTML = `
        <div class="card">
          <h3 style="font-family:'Cormorant Garamond',serif;color:var(--verde);margin-bottom:16px">Vídeo editado</h3>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
            <div style="background:var(--bege);border-radius:8px;padding:12px;text-align:center">
              <div style="font-size:1.4rem;font-family:'Cormorant Garamond',serif">${data.duration_original}s</div>
              <div style="font-size:.75rem;color:var(--muted)">duração original</div>
            </div>
            <div style="background:var(--bege);border-radius:8px;padding:12px;text-align:center">
              <div style="font-size:1.4rem;font-family:'Cormorant Garamond',serif">${data.duration_output}s</div>
              <div style="font-size:.75rem;color:var(--muted)">duração final</div>
            </div>
            <div style="background:var(--bege);border-radius:8px;padding:12px;text-align:center">
              <div style="font-size:1.4rem;font-family:'Cormorant Garamond',serif">${data.size_mb} MB</div>
              <div style="font-size:.75rem;color:var(--muted)">tamanho final</div>
            </div>
          </div>
          ${opsList.length ? `
            <div style="margin-bottom:16px">
              <p style="font-size:.8rem;font-weight:500;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:8px">Operações aplicadas</p>
              ${opsList.map(o=>`<div style="font-size:.88rem;padding:5px 0;border-bottom:1px solid var(--bege-dark)">${o}</div>`).join('')}
            </div>
          ` : ''}
          <a href="${encodeURI(data.download_url)}" download class="btn btn-accent btn-full">⬇ Baixar vídeo editado (MP4)</a>
        </div>
      `;
      toast('Vídeo editado com sucesso!');
    } catch (err) {
      result.innerHTML = `<div class="card" style="border-left:4px solid #c0392b"><p style="color:#c0392b">Erro: ${safeHtml(err.message)}</p></div>`;
      toast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '🎬 Editar vídeo';
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
        <button class="btn btn-accent btn-full" id="market-btn">📊 Pesquisar</button>
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
    btn.disabled = true; btn.textContent = '⏳ Pesquisando...';
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
      btn.disabled = false; btn.textContent = '📊 Pesquisar';
    }
  });

  await loadHistory();
}

// ── Insights ───────────────────────────────────────────
async function insights(el) {
  el.innerHTML = `
    <div class="page-header"><h1>Performance & Insights</h1></div>
    <div id="insights-data"></div>
    <div style="max-width:680px;margin-top:24px">
      <div class="card">
        <h3 style="font-family:'Cormorant Garamond',serif;color:var(--verde);margin-bottom:12px">Análise personalizada</h3>
        <div class="form-group">
          <label>Cole dados de performance (JSON ou texto)</label>
          <textarea id="insights-input" rows="6" placeholder='{"campaigns": [...]} ou cole um resumo de performance...'></textarea>
        </div>
        <button class="btn btn-accent" id="insights-btn">💡 Analisar com IA</button>
      </div>
      <div id="insights-result" style="margin-top:16px"></div>
    </div>
  `;

  try {
    const data = await api('GET', '/insights');
    const container = document.getElementById('insights-data');
    if (data.data) {
      const campaigns = data.data || [];
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
        </div>
      `;
    } else {
      container.innerHTML = `<div class="card" style="margin-bottom:16px"><p style="color:var(--muted)">${data.message || 'Configure META_ADS_ACCESS_TOKEN para ver dados de campanhas.'}</p></div>`;
    }
  } catch {}

  el.querySelector('#insights-btn').addEventListener('click', async () => {
    const raw = el.querySelector('#insights-input').value.trim();
    if (!raw) { toast('Cole dados de performance', 'error'); return; }
    const btn = el.querySelector('#insights-btn');
    btn.disabled = true; btn.textContent = '⏳ Analisando...';
    const result = document.getElementById('insights-result');
    result.innerHTML = '<div class="loading"><div class="spinner"></div> Analisando performance...</div>';

    try {
      let campaignData;
      try { campaignData = JSON.parse(raw); } catch { campaignData = { raw }; }
      const data = await api('POST', '/insights/suggest', { campaignData });
      result.innerHTML = `<div class="card"><div class="ai-output">${safeHtml(data.analysis)}</div></div>`;
      toast('Análise gerada!');
    } catch (err) {
      result.innerHTML = `<p style="color:#c0392b">Erro: ${err.message}</p>`;
      toast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '💡 Analisar com IA';
    }
  });
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

// ── Boot ───────────────────────────────────────────────
renderApp();

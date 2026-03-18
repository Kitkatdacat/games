'use strict';

// ── Hub URL ───────────────────────────────────────────────────────────────────

function getHubUrl() {
  const h = window.location.hostname;
  return (h === 'localhost' || h === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(h))
    ? `http://${h}:3000`
    : 'https://hub.kitkatdacat.com';
}

// ── State ─────────────────────────────────────────────────────────────────────

const _urlToken = new URLSearchParams(window.location.search).get('hubToken');
if (_urlToken) localStorage.setItem('tkn_games', _urlToken);

let token           = localStorage.getItem('tkn_games') || null;
let currentUser     = null;
let games           = [];
let genres          = [];
let platforms       = [];
let activeGameId    = null;
let activeReviewRating = 0;
let activeView      = 'home';
let activeSessions  = {};     // gameId -> open session object
let searchQuery     = '';
let filterStatus    = '';
let filterGenre     = '';
let filterPlatform  = '';
let heroGames       = [];
let heroIndex       = 0;
let heroTimer       = null;
let editingGameId   = null;   // null = creating new
let hostedServers   = [];
let hostedPollTimer = null;

// ── API Helper ────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-hub-session': token || '' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { localStorage.removeItem('tkn_games'); window.location.href = getHubUrl(); return; }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatPlaytime(min) {
  if (!min) return '0m';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso);
  const d = Math.floor(diff / 86400000);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 30)  return `${d} days ago`;
  if (d < 365) return `${Math.floor(d/30)} mo ago`;
  return `${Math.floor(d/365)}y ago`;
}

function statusLabel(s) {
  return { playing:'Playing', backlog:'Backlog', completed:'Completed', dropped:'Dropped' }[s] || '';
}

function mcColor(score) {
  if (!score) return '';
  return score >= 75 ? 'mc-green' : score >= 50 ? 'mc-yellow' : 'mc-red';
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast${type ? ' toast-' + type : ''}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function $id(id) { return document.getElementById(id); }

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('games-theme', t);
  $id('dd-theme-dark').classList.toggle('active', t === 'dark');
  $id('dd-theme-light').classList.toggle('active', t === 'light');
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  applyTheme(localStorage.getItem('games-theme') || 'dark');
  try {
    const status = await api('GET', '/api/auth/status');
    if (status.needsSetup) { showAuth('setup'); return; }
    if (!status.loggedIn)  { window.location.href = getHubUrl(); return; }
    currentUser = status.user;
    await loadApp();
  } catch { window.location.href = getHubUrl(); }
}

async function loadApp() {
  setUserChip();
  $id('auth-screen').classList.add('hidden');
  $id('app').classList.remove('hidden');

  if (currentUser.role === 'admin') {
    $id('dd-admin').classList.remove('hidden');
  }

  await refreshData();
  switchView('home');
  setupEvents();
  await refreshDropdownStats();
}

async function refreshData() {
  [games, genres, platforms] = await Promise.all([
    api('GET', '/api/games'),
    api('GET', '/api/genres'),
    api('GET', '/api/platforms'),
  ]);
}

function setUserChip() {
  const name = `${currentUser.firstName || ''} ${currentUser.lastName || ''}`.trim() || currentUser.username;
  const initial = (currentUser.firstName?.[0] || currentUser.username[0]).toUpperCase();
  [$id('user-avatar'), $id('user-avatar-lg')].forEach(el => { if (el) el.textContent = initial; });
  if ($id('user-full-name'))     $id('user-full-name').textContent     = name;
  if ($id('user-username'))      $id('user-username').textContent      = '@' + currentUser.username;
  if ($id('user-username-nav'))  $id('user-username-nav').textContent  = currentUser.username;
}

async function refreshDropdownStats() {
  try {
    const stats = await api('GET', '/api/library/stats');
    const el = $id('dd-library-stats');
    if (el) el.innerHTML =
      `<div>${stats.total} game${stats.total !== 1 ? 's' : ''} in library</div>` +
      `<div>${formatPlaytime(stats.totalPlaytimeMin)} played</div>` +
      `<div>${stats.byStatus.playing || 0} playing · ${stats.byStatus.completed || 0} completed</div>`;
  } catch {}
}

// ── Auth screen ───────────────────────────────────────────────────────────────

function showAuth(mode) {
  $id('app').classList.add('hidden');
  $id('auth-screen').classList.remove('hidden');
  if (mode === 'setup') {
    $id('auth-title').textContent = 'Create Account';
    $id('auth-sub').textContent   = 'Administrator setup';
    $id('auth-name-row').classList.remove('hidden');
    $id('auth-submit').textContent = 'Create Account';
    $id('auth-submit').onclick = doSetup;
  } else {
    $id('auth-title').textContent = 'Welcome Back';
    $id('auth-sub').textContent   = '';
    $id('auth-name-row').classList.add('hidden');
    $id('auth-submit').textContent = 'Sign In';
    $id('auth-submit').onclick = doLogin;
  }
}

async function doLogin() {
  const username = $id('auth-username').value.trim();
  const password = $id('auth-password').value;
  setAuthError('');
  try {
    const data = await api('POST', '/api/auth/login', { username, password });
    token = data.token;
    localStorage.setItem('tkn_games', token);
    currentUser = data.user;
    await loadApp();
  } catch (err) { setAuthError(err.message); }
}

async function doSetup() {
  const username  = $id('auth-username').value.trim();
  const password  = $id('auth-password').value;
  const firstName = $id('auth-first').value.trim();
  const lastName  = $id('auth-last').value.trim();
  setAuthError('');
  try {
    const data = await api('POST', '/api/auth/setup', { username, password, firstName, lastName });
    token = data.token;
    localStorage.setItem('tkn_games', token);
    currentUser = data.user;
    await loadApp();
  } catch (err) { setAuthError(err.message); }
}

function setAuthError(msg) {
  const el = $id('auth-error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

// ── View Switching ────────────────────────────────────────────────────────────

async function switchView(name) {
  activeView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.querySelector(`.view[data-view="${name}"]`);
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('nav-item--active', n.dataset.view === name);
  });
  await refreshData();
  if (name === 'home')      renderHome();
  if (name === 'library')   renderLibrary();
  if (name === 'search')    renderSearch();
  if (name === 'admin')     renderAdmin();
  if (name === 'hosted')    { renderHosted(); startHostedPoll(); }
  if (name !== 'hosted')    stopHostedPoll();
  if (name === 'emulators') { activeEmuSystem = null; renderEmulators(); }
}

// ── Hero Banner ───────────────────────────────────────────────────────────────

function buildHeroGames() {
  // Prioritise: currently playing > highest metacritic > newest
  const playing   = games.filter(g => g.libraryEntry?.status === 'playing');
  const rest      = games.filter(g => g.libraryEntry?.status !== 'playing');
  const sorted    = rest.slice().sort((a, b) => (b.metacritic || 0) - (a.metacritic || 0));
  const pool      = [...playing, ...sorted];
  heroGames       = pool.filter(g => g.hero_url || g.cover_url).slice(0, 6);
  if (!heroGames.length) heroGames = games.slice(0, 6);
}

function renderHero() {
  buildHeroGames();
  if (!heroGames.length) { $id('hero-banner').style.display = 'none'; return; }
  $id('hero-banner').style.display = '';
  heroIndex = 0;
  renderHeroDots();
  setHeroSlide(0);
  startHeroRotation();
}

function renderHeroDots() {
  $id('hero-dots').innerHTML = heroGames.map((_, i) =>
    `<button class="hero-dot${i === 0 ? ' active' : ''}" data-i="${i}"></button>`
  ).join('');
}

function setHeroSlide(i) {
  heroIndex = ((i % heroGames.length) + heroGames.length) % heroGames.length;
  const g = heroGames[heroIndex];
  const bg = $id('hero-bg');
  bg.style.backgroundImage = `url('${(g.hero_url || g.cover_url).replace(/'/g, '%27')}')`;

  const badge = $id('hero-status-badge');
  const status = g.libraryEntry?.status;
  if (status) {
    badge.textContent = statusLabel(status);
    badge.className = '';
    badge.style.cssText = '';
    const colors = { playing:'var(--accent)', completed:'var(--success)', backlog:'var(--surface-3)', dropped:'var(--danger)' };
    badge.style.background = colors[status] || 'var(--surface-3)';
    badge.style.color = '#fff';
    badge.style.padding = '3px 10px'; badge.style.borderRadius = '3px';
    badge.style.fontSize = '10px'; badge.style.fontWeight = '700';
    badge.style.textTransform = 'uppercase'; badge.style.letterSpacing = '.12em';
    badge.style.marginBottom = '10px'; badge.style.display = 'inline-block';
    badge.classList.remove('hidden');
  } else { badge.classList.add('hidden'); }

  $id('hero-title').textContent = g.title;
  $id('hero-description').textContent = g.description || '';
  $id('hero-meta').innerHTML = [
    g.release_year ? `<span class="chip">${g.release_year}</span>` : '',
    ...(g.genres || []).slice(0, 3).map(gn => `<span class="chip">${esc(gn)}</span>`),
    g.metacritic ? `<span class="chip ${mcColor(g.metacritic)}">${g.metacritic}</span>` : '',
  ].join('');

  document.querySelectorAll('.hero-dot').forEach((d, idx) =>
    d.classList.toggle('active', idx === heroIndex)
  );
  $id('hero-detail-btn').onclick = () => openDetailModal(g.id);

  const playBtn = $id('hero-play-btn');
  function updateHeroLibBtn() {
    const inLib = !!g.libraryEntry;
    playBtn.textContent = inLib ? '— Remove from Library' : '+ Add to Library';
    playBtn.className = 'btn-hero-lib' + (inLib ? ' in-library' : '');
  }
  updateHeroLibBtn();
  playBtn.onclick = async () => {
    const inLib = !!g.libraryEntry;
    try {
      if (!inLib) {
        await api('PUT', `/api/library/${g.id}`, { status: 'backlog' });
        toast('Added to library', 'success');
      } else {
        await api('DELETE', `/api/library/${g.id}`);
        toast('Removed from library');
      }
      await refreshData();
      // re-find game with updated libraryEntry
      const updated = games.find(gg => gg.id === g.id);
      if (updated) { g.libraryEntry = updated.libraryEntry; }
      updateHeroLibBtn();
    } catch (err) { toast(err.message, 'error'); }
  };
}

function startHeroRotation() {
  clearInterval(heroTimer);
  if (heroGames.length > 1) heroTimer = setInterval(() => setHeroSlide(heroIndex + 1), 7000);
}

// ── Shelf System ──────────────────────────────────────────────────────────────

function renderHome() {
  renderHero();
  const container = $id('shelves-container');
  container.innerHTML = '';

  const gamesInStatus = s => games.filter(g => g.libraryEntry?.status === s);
  const newestGames   = games.slice().sort((a,b) => b.created_at?.localeCompare(a.created_at)).slice(0, 20);
  const topRated      = games.slice().sort((a,b) => (b.metacritic||0) - (a.metacritic||0)).filter(g => g.metacritic).slice(0, 20);

  const shelves = [
    { id: 'continue',  label: 'Continue Playing',   list: gamesInStatus('playing') },
    { id: 'new',       label: 'New to the Catalog',  list: newestGames },
    { id: 'backlog',   label: 'Your Backlog',         list: gamesInStatus('backlog') },
    { id: 'top-rated', label: 'Top Rated',            list: topRated },
    { id: 'completed', label: 'Completed',            list: gamesInStatus('completed') },
    { id: 'all',       label: 'All Games',            list: games },
  ];

  for (const s of shelves) {
    if (!s.list.length) continue;
    container.insertAdjacentHTML('beforeend', renderShelf(s.id, s.label, s.list));
  }

  // Attach shelf scroll arrow events
  container.querySelectorAll('.shelf-arrow').forEach(btn => {
    btn.addEventListener('click', () => {
      const shelf = btn.closest('.shelf');
      const track = shelf.querySelector('.shelf-track');
      const isRight = btn.classList.contains('shelf-arrow--right');
      const step = 160 * 3;
      if (isRight) {
        if (track.scrollLeft + track.clientWidth >= track.scrollWidth - 4) {
          track.scrollTo({ left: 0, behavior: 'smooth' });
        } else {
          track.scrollBy({ left: step, behavior: 'smooth' });
        }
      } else {
        if (track.scrollLeft <= 4) {
          track.scrollTo({ left: track.scrollWidth, behavior: 'smooth' });
        } else {
          track.scrollBy({ left: -step, behavior: 'smooth' });
        }
      }
    });
  });
  container.querySelectorAll('.shelf-see-all').forEach(btn => {
    btn.addEventListener('click', () => switchView('library'));
  });
  attachCardClicks(container);
}

function renderShelf(id, label, list) {
  return `
    <section class="shelf" id="shelf-${id}">
      <div class="shelf-header">
        <h2 class="shelf-title">${esc(label)}</h2>
        <button class="shelf-see-all">See All</button>
      </div>
      <div class="shelf-track" id="shelf-track-${id}">
        <button class="shelf-arrow shelf-arrow--left">&#8249;</button>
        ${list.map(renderGameCard).join('')}
        <button class="shelf-arrow shelf-arrow--right">&#8250;</button>
      </div>
    </section>`;
}

// ── Game Card ─────────────────────────────────────────────────────────────────

function renderGameCard(g, showStatus = false, showLibBtn = false) {
  const status  = showStatus ? (g.libraryEntry?.status || g.status || '') : '';
  const inLib   = !!g.libraryEntry;
  const mc      = g.metacritic;
  const chips   = (g.platforms || []).slice(0, 2).map(p => `<span class="chip" style="font-size:9px">${esc(p)}</span>`).join('');
  const mcBadge = mc ? `<span class="game-card-mc ${mcColor(mc)}">${mc}</span>` : '';
  const badge   = status ? `<div class="game-card-badge">${esc(statusLabel(status))}</div>` : '';
  const libBtn  = showLibBtn ? `<button class="card-lib-btn${inLib ? ' in-library' : ''}" data-lib="${esc(g.id)}">${inLib ? '— Remove' : '+ Library'}</button>` : '';
  const style   = g.cover_url
    ? `background-image:url('${g.cover_url.replace(/'/g, '%27')}')`
    : 'background:linear-gradient(135deg,var(--surface-2),var(--surface-3))';

  return `
    <div class="game-card${status ? ' status-' + status : ''}" data-id="${esc(g.id)}" style="${style}">
      ${libBtn}
      ${badge}
      ${!g.cover_url ? `<div class="game-card-no-cover">${esc(g.title)}</div>` : ''}
      <div class="game-card-overlay">
        <div class="game-card-title">${esc(g.title)}</div>
        <div class="game-card-dev">${esc(g.developer || '')}</div>
        <div class="game-card-chips">${chips}</div>
        ${mcBadge}
      </div>
    </div>`;
}

function attachCardClicks(root) {
  root.querySelectorAll('.game-card[data-id]').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('[data-lib]')) return;
      openDetailModal(card.dataset.id);
    });
  });
  root.querySelectorAll('[data-lib]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const gameId = btn.dataset.lib;
      const game = games.find(g => g.id === gameId);
      const adding = !game?.libraryEntry;
      try {
        if (adding) {
          await api('PUT', `/api/library/${gameId}`, { status: 'backlog' });
          toast('Added to library', 'success');
        } else {
          await api('DELETE', `/api/library/${gameId}`);
          toast('Removed from library');
        }
        await refreshData();
        btn.textContent = adding ? '— Remove' : '+ Library';
        btn.classList.toggle('in-library', adding);
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// ── Library View ──────────────────────────────────────────────────────────────

function renderLibrary() {
  const filtered = filterStatus
    ? games.filter(g => g.libraryEntry?.status === filterStatus)
    : games.filter(g => g.libraryEntry);
  const grid = $id('library-grid');

  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state"><strong>Nothing here yet.</strong><p>Add games to your library from the home screen or Browse.</p></div>`;
  } else {
    grid.innerHTML = filtered.map(g => renderGameCard(g, true)).join('');
    attachCardClicks(grid);
  }

  const total = games.filter(g => g.libraryEntry).length;
  $id('library-stats-bar').textContent = total
    ? `${total} game${total !== 1 ? 's' : ''} in your library`
    : 'Your library is empty.';
}

// ── Browse / Search View ──────────────────────────────────────────────────────

function renderSearch() {
  renderFilterStrips();
  applySearchFilter();
}

function renderFilterStrips() {
  $id('genre-filter-strip').innerHTML =
    `<button class="filter-chip${!filterGenre ? ' active' : ''}" data-type="genre" data-val="">All Genres</button>` +
    genres.map(g =>
      `<button class="filter-chip${filterGenre === g.name ? ' active' : ''}" data-type="genre" data-val="${esc(g.name)}">${esc(g.name)}</button>`
    ).join('');

  $id('platform-filter-strip').innerHTML =
    `<button class="filter-chip${!filterPlatform ? ' active' : ''}" data-type="platform" data-val="">All Platforms</button>` +
    platforms.map(p =>
      `<button class="filter-chip${filterPlatform === p.name ? ' active' : ''}" data-type="platform" data-val="${esc(p.name)}">${esc(p.name)}</button>`
    ).join('');

  document.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.type === 'genre')    { filterGenre    = btn.dataset.val; }
      if (btn.dataset.type === 'platform') { filterPlatform = btn.dataset.val; }
      renderSearch();
    });
  });
}

function applySearchFilter() {
  let result = games;
  if (searchQuery)   result = result.filter(g => g.title.toLowerCase().includes(searchQuery.toLowerCase()) || (g.developer || '').toLowerCase().includes(searchQuery.toLowerCase()));
  if (filterGenre)   result = result.filter(g => (g.genres || []).includes(filterGenre));
  if (filterPlatform) result = result.filter(g => (g.platforms || []).includes(filterPlatform));

  const grid = $id('search-results-grid');
  if (!result.length) {
    grid.innerHTML = `<div class="empty-state"><strong>No games found.</strong><p>Try different filters or add games via the Admin panel.</p></div>`;
  } else {
    grid.innerHTML = result.map(g => renderGameCard(g, false, true)).join('');
    attachCardClicks(grid);
  }
}

// ── Detail Modal ──────────────────────────────────────────────────────────────

async function openDetailModal(gameId) {
  activeGameId = gameId;
  const modal = $id('game-detail-modal');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  let game = games.find(g => g.id === gameId);
  if (!game) return;

  renderModalInfo(game);
  renderModalControls(game);

  // Library button
  const libBtn = $id('modal-library-btn');

  function updateLibBtn() {
    const inLib = !!game?.libraryEntry;
    libBtn.textContent = inLib ? '— Remove from Library' : '+ Add to Library';
    libBtn.className = 'modal-library-btn' + (inLib ? ' in-library' : '');
  }

  updateLibBtn();
  libBtn.onclick = async () => {
    try {
      if (game?.libraryEntry) {
        await api('DELETE', `/api/library/${gameId}`);
        toast('Removed from library');
      } else {
        await api('PUT', `/api/library/${gameId}`, { status: 'backlog' });
        toast('Added to library', 'success');
      }
      await refreshData();
      game = games.find(g => g.id === gameId);
      updateLibBtn();
    } catch (err) { toast(err.message, 'error'); }
  };

  await loadModalPlaytime(game);
  await renderReviews(gameId);
}

function closeDetailModal() {
  $id('game-detail-modal').classList.add('hidden');
  document.body.style.overflow = '';
  activeGameId = null;
}

function renderModalInfo(game) {
  // Hero image
  const heroSrc = game.hero_url || game.cover_url;
  const img = $id('modal-hero-img');
  if (heroSrc) { img.src = heroSrc; img.style.display = ''; }
  else          { img.style.display = 'none'; }

  // Metacritic badge
  const mcBadge = $id('modal-metacritic-badge');
  if (game.metacritic) {
    mcBadge.textContent = game.metacritic;
    mcBadge.className   = `mc-badge ${mcColor(game.metacritic)}`;
    mcBadge.style.padding = '4px 10px'; mcBadge.style.borderRadius = '5px';
    mcBadge.style.fontWeight = '800'; mcBadge.style.fontSize = '13px'; mcBadge.style.zIndex = '2';
    mcBadge.classList.remove('hidden');
  } else { mcBadge.classList.add('hidden'); }

  $id('modal-title').textContent = game.title;

  // Meta row
  $id('modal-meta-row').innerHTML = [
    game.release_year ? `<span class="modal-meta-item">${game.release_year}</span>` : '',
    game.developer    ? `<span class="modal-meta-item">by ${esc(game.developer)}</span>` : '',
    game.publisher && game.publisher !== game.developer ? `<span class="modal-meta-item">${esc(game.publisher)}</span>` : '',
    game.rating_esrb  ? `<span class="chip">${esc(game.rating_esrb)}</span>` : '',
  ].join('<span class="modal-meta-item" style="color:var(--border)">·</span>');

  // Chips row
  $id('modal-chips-row').innerHTML = [
    ...(game.genres   || []).map(g => `<span class="chip chip-accent">${esc(g)}</span>`),
    ...(game.platforms || []).map(p => `<span class="chip">${esc(p)}</span>`),
    ...(game.tags      || []).map(t => `<span class="chip">${esc(t)}</span>`),
  ].join('');

  $id('modal-description').textContent = game.description || '';

  // Trailer
  const trailerWrap = $id('modal-trailer');
  if (game.trailer_url) {
    const embedUrl = game.trailer_url.replace('watch?v=', 'embed/').replace('youtu.be/', 'www.youtube.com/embed/');
    $id('modal-trailer-iframe').src = embedUrl;
    trailerWrap.classList.remove('hidden');
  } else {
    trailerWrap.classList.add('hidden');
    $id('modal-trailer-iframe').src = '';
  }
}

function renderModalControls() {}

function renderReviewStars(container, rating) {
  activeReviewRating = rating || 0;

  container.innerHTML = Array.from({ length: 5 }, (_, i) =>
    `<button type="button" class="star-btn" data-n="${i + 1}" style="background:none;border:none;font-size:24px;cursor:pointer;padding:0 3px;line-height:1">★</button>`
  ).join('');

  const btns = Array.from(container.querySelectorAll('.star-btn'));

  function paint(val) {
    btns.forEach((b, i) => {
      const on = i + 1 <= val;
      b.style.color = on ? '#d0ff00' : 'var(--border)';
      b.style.textShadow = on ? '0 0 8px #d0ff00' : 'none';
    });
  }

  btns.forEach(b => {
    const n = parseInt(b.dataset.n);
    b.addEventListener('mouseenter', () => paint(n));
    b.addEventListener('click', () => {
      activeReviewRating = n;
      container.dataset.selectedRating = n;
      paint(n);
    });
  });

  container.addEventListener('mouseleave', () => paint(activeReviewRating));
  container.dataset.selectedRating = activeReviewRating;
  paint(activeReviewRating);
}

async function renderReviews(gameId) {
  let reviews;
  try {
    reviews = await api('GET', `/api/games/${gameId}/reviews`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const list = $id('modal-reviews-list');
  const mine = reviews.find(r => r.user_id === currentUser?.id);

  // Show existing reviews
  list.innerHTML = reviews.length ? reviews.map(r => `
    <div class="review-item">
      <div class="review-header">
        <span class="review-author">${esc(r.username)}</span>
        <span class="review-stars"><span style="color:#d0ff00;text-shadow:0 0 4px #d0ff00">${'★'.repeat(r.rating)}</span><span style="color:var(--border)">${'☆'.repeat(5 - r.rating)}</span></span>
        <span class="review-date">${timeAgo(r.created_at)}</span>
      </div>
      <div class="review-body">${esc(r.body)}</div>
    </div>`).join('') : `<p style="color:var(--text-3);font-size:12px;margin-bottom:12px">No reviews yet.</p>`;

  // Pre-fill form if user already reviewed
  renderReviewStars($id('modal-review-stars'), mine?.rating || 0);
  if (mine) {
    $id('modal-review-body').value = mine.body;
    $id('modal-review-delete').classList.remove('hidden');
    $id('modal-review-submit').textContent = 'Update Review';
  } else {
    $id('modal-review-body').value = '';
    $id('modal-review-delete').classList.add('hidden');
    $id('modal-review-submit').textContent = 'Post Review';
  }

  $id('modal-review-submit').onclick = async () => {
    const body = $id('modal-review-body').value.trim();
    const rating = parseInt($id('modal-review-stars').dataset.selectedRating) || 0;
    if (!rating) return toast('Select a star rating', 'error');
    if (!body) return toast('Write something first', 'error');
    try {
      await api('PUT', `/api/games/${gameId}/reviews`, { rating, body });
      await renderReviews(gameId);
      $id('modal-review-body').value = '';
      renderReviewStars($id('modal-review-stars'), 0);
      toast('Review saved', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
  $id('modal-review-delete').onclick = async () => {
    await api('DELETE', `/api/games/${gameId}/reviews`);
    renderReviews(gameId);
    toast('Review deleted');
  };
}

async function saveModalEntry() {
  if (!activeGameId) return;
  const status = $id('modal-status').value;
  try {
    if (!status) {
      await api('DELETE', `/api/library/${activeGameId}`);
    } else {
      await api('PUT', `/api/library/${activeGameId}`, { status });
    }
    await refreshData();
    const updated = games.find(g => g.id === activeGameId);
    if (updated) {
      renderModalControls(updated);
      updateCardInDOM(updated);
    }
    $id('modal-remove-btn').style.display = status ? '' : 'none';
    toast('Saved', 'success');
    await refreshDropdownStats();
  } catch (err) { toast(err.message, 'error'); }
}

async function removeModalEntry() {
  if (!activeGameId) return;
  try {
    await api('DELETE', `/api/library/${activeGameId}`);
    await refreshData();
    const updated = games.find(g => g.id === activeGameId);
    if (updated) { renderModalControls(updated); updateCardInDOM(updated); }
    toast('Removed from library');
    await refreshDropdownStats();
  } catch (err) { toast(err.message, 'error'); }
}

function updateCardInDOM(game) {
  document.querySelectorAll(`.game-card[data-id="${game.id}"]`).forEach(card => {
    const parent = card.parentElement;
    const newCard = document.createElement('div');
    newCard.innerHTML = renderGameCard(game);
    const newEl = newCard.firstElementChild;
    parent.replaceChild(newEl, card);
    newEl.addEventListener('click', () => openDetailModal(game.id));
  });
}

async function loadModalPlaytime(game) {
  const playtime = await api('GET', `/api/games/${game.id}/playtime`);
  const openSession = activeSessions[game.id];

  $id('modal-playtime-total').innerHTML =
    `${formatPlaytime(playtime.total_min)}<span>total playtime</span>`;

  // Inline playtime near title
  const inlineEl = $id('modal-playtime-inline');
  if (inlineEl) inlineEl.innerHTML = playtime.total_min > 0
    ? `<span class="modal-playtime-badge">⏱ ${formatPlaytime(playtime.total_min)}</span>`
    : '';

  // Session controls — top play button
  const ctrl = $id('modal-session-controls');
  const playBtn = $id('modal-play-btn');
  if (openSession) {
    if (playBtn) playBtn.style.display = 'none';
    ctrl.innerHTML = `
      <div class="session-active">
        <div class="session-active-dot"></div>
        <span style="font-size:12px;flex:1">Session in progress…</span>
        <button class="btn btn-accent btn-sm" id="end-session-btn">End Session</button>
      </div>`;
    $id('end-session-btn').onclick = () => endActiveSession(game.id);
  } else {
    if (playBtn) {
      playBtn.style.display = '';
      playBtn.onclick = async () => {
        try {
          if (game.rom_id) {
            const rom = await api('GET', `/api/roms/${game.rom_id}`);
            closeDetailModal();
            activeEmuSystem = rom.system;
            launchEmulator(rom.id, game.title);
          } else {
            // Try to auto-match by title
            const allRoms = await api('GET', '/api/roms');
            const needle = game.title.toLowerCase().replace(/[^a-z0-9]/g, '');
            const match = allRoms.find(r =>
              r.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(needle) ||
              needle.includes(r.name.toLowerCase().replace(/[^a-z0-9]/g, ''))
            );
            if (match) {
              closeDetailModal();
              activeEmuSystem = match.system;
              launchEmulator(match.id, game.title);
            } else {
              toast('No ROM linked to this game — link one in Admin', 'error');
            }
          }
        } catch (err) { toast(err.message, 'error'); }
      };
    }
    ctrl.innerHTML = '';
  }

  // Session list
  $id('modal-session-list').innerHTML = playtime.sessions
    .filter(s => s.ended_at)
    .slice(0, 10)
    .map(s => `
      <div class="session-item">
        <span class="session-dur">${formatPlaytime(s.duration_min)}</span>
        <span class="session-date">${timeAgo(s.started_at)}</span>
        ${s.notes ? `<span class="session-note">${esc(s.notes)}</span>` : ''}
      </div>`
    ).join('');

  // Manual session form
  $id('modal-add-session-btn').onclick = () =>
    $id('modal-manual-session').classList.toggle('hidden');
  $id('ms-save-btn').onclick = async () => {
    const start = $id('ms-start').value;
    const end   = $id('ms-end').value;
    if (!start || !end) { toast('Fill in start and end times', 'error'); return; }
    const dur = Math.max(0, Math.floor((new Date(end) - new Date(start)) / 60000));
    const notes = $id('ms-notes').value;
    try {
      await api('POST', `/api/games/${game.id}/sessions`, { started_at: new Date(start).toISOString(), ended_at: new Date(end).toISOString(), duration_min: dur, notes });
      $id('modal-manual-session').classList.add('hidden');
      $id('ms-start').value = ''; $id('ms-end').value = ''; $id('ms-notes').value = '';
      await loadModalPlaytime(game);
      toast('Session added', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function startActiveSession(gameId) {
  try {
    const session = await api('POST', `/api/games/${gameId}/sessions/start`);
    activeSessions[gameId] = session;
    const game = games.find(g => g.id === gameId);
    if (game) await loadModalPlaytime(game);
    toast('Session started');
  } catch (err) { toast(err.message, 'error'); }
}

async function endActiveSession(gameId) {
  const session = activeSessions[gameId];
  if (!session) return;
  try {
    await api('POST', `/api/games/${gameId}/sessions/${session.id}/end`);
    delete activeSessions[gameId];
    const game = games.find(g => g.id === gameId);
    if (game) await loadModalPlaytime(game);
    toast('Session ended', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// ── Admin View ────────────────────────────────────────────────────────────────

function renderAdmin() {
  renderAdminCatalog();
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => switchAdminTab(tab.dataset.atab));
  });
}

function switchAdminTab(name) {
  document.querySelectorAll('.admin-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.atab === name)
  );
  document.querySelectorAll('.admin-tab-panel').forEach(p =>
    p.classList.toggle('hidden', p.id !== `admin-tab-${name}`)
  );
  if (name === 'catalog')        renderAdminCatalog();
  if (name === 'add-game')       renderGameForm(null);
  if (name === 'genres')         renderGenresAdmin();
  if (name === 'platforms')      renderPlatformsAdmin();
  if (name === 'hosted-servers') renderAdminHosted();
}

function renderAdminCatalog() {
  const wrap = $id('admin-game-table-wrap');
  if (!games.length) {
    wrap.innerHTML = `<div class="empty-state"><strong>No games yet.</strong><p>Use the Add Game tab to create the first one.</p></div>`;
    return;
  }
  wrap.innerHTML = `
    <div style="margin-bottom:12px;text-align:right">
      <button class="btn btn-accent btn-sm" id="admin-add-game-quick">+ Add Game</button>
    </div>
    <table class="admin-game-table">
      <thead><tr>
        <th></th><th>Title</th><th>Developer</th><th>Year</th><th>Platforms</th><th>Metacritic</th><th></th>
      </tr></thead>
      <tbody>
        ${games.map(g => `
          <tr>
            <td>${g.cover_url ? `<img src="${esc(g.cover_url)}" alt="" loading="lazy">` : '<div class="admin-cover-placeholder"></div>'}</td>
            <td><strong>${esc(g.title)}</strong></td>
            <td>${esc(g.developer || '—')}</td>
            <td>${g.release_year || '—'}</td>
            <td>${(g.platforms||[]).slice(0,2).join(', ') || '—'}</td>
            <td>${g.metacritic || '—'}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-ghost btn-sm" data-edit="${esc(g.id)}">Edit</button>
              <button class="btn btn-danger btn-sm" data-del="${esc(g.id)}" style="margin-left:4px">Del</button>
            </td>
          </tr>`
        ).join('')}
      </tbody>
    </table>`;

  $id('admin-add-game-quick').onclick = () => switchAdminTab('add-game');

  wrap.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      switchAdminTab('add-game');
      renderGameForm(btn.dataset.edit);
    });
  });
  wrap.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this game? This cannot be undone.')) return;
      try {
        await api('DELETE', `/api/games/${btn.dataset.del}`);
        await refreshData();
        renderAdminCatalog();
        toast('Game deleted');
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

function renderGameForm(gameId) {
  editingGameId = gameId || null;
  const game = gameId ? games.find(g => g.id === gameId) : null;
  const v = k => esc(game?.[k] || '');
  const arr = k => (game?.[k] || []).join(', ');

  $id('admin-game-form').innerHTML = `
    <h3 style="margin-bottom:20px;font-size:16px">${game ? 'Edit' : 'Add'} Game</h3>
    ${!game ? `<div style="display:flex;gap:8px;margin-bottom:20px">
      <input id="gf-rawg-search" placeholder="Search RAWG to auto-fill…" style="flex:1" />
      <button class="btn btn-ghost" id="gf-rawg-btn">Search</button>
    </div>
    <div id="gf-rawg-results" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px"></div>` : ''}
    <div class="form-row-two">
      <div class="field-wrap"><label>Title *</label><input id="gf-title" value="${v('title')}" /></div>
      <div class="field-wrap"><label>Developer</label><input id="gf-dev" value="${v('developer')}" /></div>
    </div>
    <div class="form-row-two">
      <div class="field-wrap"><label>Publisher</label><input id="gf-pub" value="${v('publisher')}" /></div>
      <div class="field-wrap"><label>Release Year</label><input id="gf-year" type="number" value="${game?.release_year || ''}" /></div>
    </div>
    <div class="field-wrap"><label>Description</label><textarea id="gf-desc" rows="3">${v('description')}</textarea></div>
    <div class="form-row-two">
      <div class="field-wrap"><label>Cover Image URL</label><input id="gf-cover" value="${v('cover_url')}" placeholder="https://…" /></div>
      <div class="field-wrap"><label>Hero/Banner Image URL</label><input id="gf-hero" value="${v('hero_url')}" placeholder="https://…" /></div>
    </div>
    <div class="form-row-two">
      <div class="field-wrap"><label>Genres (comma-separated)</label><input id="gf-genres" value="${arr('genres')}" /></div>
      <div class="field-wrap"><label>Platforms (comma-separated)</label><input id="gf-platforms" value="${arr('platforms')}" /></div>
    </div>
    <div class="form-row-two">
      <div class="field-wrap"><label>Tags (comma-separated)</label><input id="gf-tags" value="${arr('tags')}" /></div>
      <div class="field-wrap"><label>ESRB Rating</label>
        <select id="gf-esrb">
          <option value="">—</option>
          ${['E','E10+','T','M','AO'].map(r => `<option${game?.rating_esrb === r ? ' selected' : ''}>${r}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row-two">
      <div class="field-wrap"><label>Metacritic (0–100)</label><input id="gf-mc" type="number" min="0" max="100" value="${game?.metacritic || ''}" /></div>
      <div class="field-wrap"><label>Trailer URL (YouTube)</label><input id="gf-trailer" value="${v('trailer_url')}" placeholder="https://youtube.com/…" /></div>
    </div>
    <div class="field-wrap"><label>Linked ROM (for Play button)</label>
      <select id="gf-rom"><option value="">— None —</option></select>
    </div>
    <div style="display:flex;gap:10px;margin-top:20px">
      <button class="btn btn-accent" id="gf-save">${game ? 'Save Changes' : 'Add Game'}</button>
      ${game ? '<button class="btn btn-ghost" id="gf-cancel">Cancel</button>' : ''}
    </div>
    <div id="gf-error" class="field-error hidden" style="margin-top:8px"></div>`;

  $id('gf-save').onclick = saveGameForm;
  if ($id('gf-cancel')) $id('gf-cancel').onclick = () => switchAdminTab('catalog');

  // Populate ROM selector
  api('GET', '/api/roms').then(roms => {
    const sel = $id('gf-rom');
    if (!sel) return;
    roms.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.name} (${r.system})`;
      if (r.id === game?.rom_id) opt.selected = true;
      sel.appendChild(opt);
    });
  }).catch(() => {});

  if (!game) {
    const doSearch = async () => {
      const q = $id('gf-rawg-search').value.trim();
      if (!q) return;
      const results = await api('GET', `/api/rawg/search?q=${encodeURIComponent(q)}`);
      $id('gf-rawg-results').innerHTML = results.map(r => `
        <button class="btn btn-ghost btn-sm rawg-result" data-slug="${r.slug}" style="display:flex;align-items:center;gap:6px">
          ${r.cover ? `<img src="${esc(r.cover)}" style="width:28px;height:40px;object-fit:cover;border-radius:3px">` : ''}
          <span>${esc(r.name)}${r.year ? ` <small style="color:var(--text-3)">(${r.year})</small>` : ''}</span>
        </button>`).join('');
      $id('gf-rawg-results').querySelectorAll('.rawg-result').forEach(btn => {
        btn.onclick = async () => {
          const detail = await api('GET', `/api/rawg/game/${btn.dataset.slug}`);
          $id('gf-title').value    = detail.title || '';
          $id('gf-dev').value      = detail.developer || '';
          $id('gf-pub').value      = detail.publisher || '';
          $id('gf-year').value     = detail.release_year || '';
          $id('gf-desc').value     = detail.description || '';
          $id('gf-cover').value    = detail.cover_url || '';
          $id('gf-genres').value   = (detail.genres || []).join(', ');
          $id('gf-platforms').value= (detail.platforms || []).join(', ');
          $id('gf-mc').value       = detail.metacritic || '';
          const esrb = $id('gf-esrb');
          if (detail.rating_esrb) esrb.value = detail.rating_esrb;
          $id('gf-rawg-results').innerHTML = '';
          $id('gf-rawg-search').value = '';
          toast('Details filled from RAWG', 'success');
        };
      });
    };
    $id('gf-rawg-btn').onclick = doSearch;
    $id('gf-rawg-search').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  }
}

function parseCSV(str) {
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

async function saveGameForm() {
  const title = $id('gf-title').value.trim();
  if (!title) { $id('gf-error').textContent = 'Title is required'; $id('gf-error').classList.remove('hidden'); return; }
  $id('gf-error').classList.add('hidden');
  const payload = {
    title,
    developer:    $id('gf-dev').value.trim(),
    publisher:    $id('gf-pub').value.trim(),
    release_year: parseInt($id('gf-year').value) || null,
    description:  $id('gf-desc').value.trim(),
    cover_url:    $id('gf-cover').value.trim(),
    hero_url:     $id('gf-hero').value.trim(),
    genres:       parseCSV($id('gf-genres').value),
    platforms:    parseCSV($id('gf-platforms').value),
    tags:         parseCSV($id('gf-tags').value),
    rating_esrb:  $id('gf-esrb').value || null,
    metacritic:   parseInt($id('gf-mc').value) || null,
    trailer_url:  $id('gf-trailer').value.trim() || null,
    rom_id:       $id('gf-rom').value || null,
  };
  try {
    if (editingGameId) {
      await api('PUT', `/api/games/${editingGameId}`, payload);
      toast('Game updated', 'success');
    } else {
      await api('POST', '/api/games', payload);
      toast('Game added', 'success');
    }
    await refreshData();
    switchAdminTab('catalog');
  } catch (err) {
    $id('gf-error').textContent = err.message;
    $id('gf-error').classList.remove('hidden');
  }
}

function renderGenresAdmin() {
  $id('admin-genres-list').innerHTML = `<div class="admin-lookup-list">${
    genres.map(g => `
      <div class="admin-lookup-item">
        ${esc(g.name)}
        <button class="admin-lookup-delete" data-id="${g.id}" title="Delete">×</button>
      </div>`
    ).join('')
  }</div>`;
  $id('admin-genres-list').querySelectorAll('.admin-lookup-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('DELETE', `/api/genres/${btn.dataset.id}`); genres = await api('GET', '/api/genres'); renderGenresAdmin(); }
      catch (err) { toast(err.message, 'error'); }
    });
  });
  $id('genre-add-btn').onclick = async () => {
    const name = $id('genre-input').value.trim();
    if (!name) return;
    try { await api('POST', '/api/genres', { name }); $id('genre-input').value = ''; genres = await api('GET', '/api/genres'); renderGenresAdmin(); }
    catch (err) { toast(err.message, 'error'); }
  };
}

function renderPlatformsAdmin() {
  $id('admin-platforms-list').innerHTML = `<div class="admin-lookup-list">${
    platforms.map(p => `
      <div class="admin-lookup-item">
        ${esc(p.name)}
        <button class="admin-lookup-delete" data-id="${p.id}" title="Delete">×</button>
      </div>`
    ).join('')
  }</div>`;
  $id('admin-platforms-list').querySelectorAll('.admin-lookup-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('DELETE', `/api/platforms/${btn.dataset.id}`); platforms = await api('GET', '/api/platforms'); renderPlatformsAdmin(); }
      catch (err) { toast(err.message, 'error'); }
    });
  });
  $id('platform-add-btn').onclick = async () => {
    const name = $id('platform-input').value.trim();
    if (!name) return;
    try { await api('POST', '/api/platforms', { name }); $id('platform-input').value = ''; platforms = await api('GET', '/api/platforms'); renderPlatformsAdmin(); }
    catch (err) { toast(err.message, 'error'); }
  };
}

// ── Event Setup ───────────────────────────────────────────────────────────────

function setupEvents() {
  // Nav sidebar
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Header search
  $id('search-input').addEventListener('input', debounce(e => {
    searchQuery = e.target.value.trim();
    if (activeView !== 'search') switchView('search');
    else applySearchFilter();
  }, 300));
  $id('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && activeView !== 'search') switchView('search');
  });

  // User dropdown — open on click, close on mouseleave (with delay to bridge gap)
  let _ddCloseTimer;
  const _ddWrap = $id('user-avatar-wrap');
  const _dd = $id('user-dropdown');
  const _ddOpen  = () => { clearTimeout(_ddCloseTimer); };
  const _ddClose = () => { _ddCloseTimer = setTimeout(() => _dd.classList.add('hidden'), 150); };

  $id('user-avatar-btn').addEventListener('click', e => {
    e.stopPropagation();
    _dd.classList.toggle('hidden');
  });
  _ddWrap.addEventListener('mouseleave', _ddClose);
  _ddWrap.addEventListener('mouseenter', _ddOpen);
  _dd.addEventListener('mouseenter', _ddOpen);
  _dd.addEventListener('mouseleave', _ddClose);
  document.addEventListener('click', e => {
    if (!_ddWrap.contains(e.target)) _dd.classList.add('hidden');
  });

  // Theme buttons
  $id('dd-theme-dark').addEventListener('click',  () => applyTheme('dark'));
  $id('dd-theme-light').addEventListener('click', () => applyTheme('light'));

  // Help
  $id('dd-help').addEventListener('click', () => {
    $id('user-dropdown').classList.add('hidden');
    window.open(`${getHubUrl()}/help/games/`, '_blank');
  });

  // Leave to Hub / Admin
  $id('dd-leave').addEventListener('click', () => {
    api('POST', '/api/auth/logout').catch(() => {});
    localStorage.removeItem('tkn_games');
    window.location.href = getHubUrl();
  });
  $id('dd-admin').addEventListener('click', () => {
    $id('user-dropdown').classList.add('hidden');
    switchView('admin');
  });

  $id('hosted-add-btn').addEventListener('click', async () => {
    const name  = $id('hosted-name-input').value.trim();
    const host  = $id('hosted-host-input').value.trim();
    const port  = parseInt($id('hosted-port-input').value) || 25565;
    const start = $id('hosted-start-input').value.trim();
    const stop  = $id('hosted-stop-input').value.trim();
    const desc  = $id('hosted-desc-input').value.trim();
    if (!name || !host) { toast('Name and host are required', 'error'); return; }
    const image  = $id('hosted-image-input').value.trim();
    const config = $id('hosted-config-input').value.trim();
    try {
      await api('POST', '/api/hosted', { name, host, port, start_command: start, stop_command: stop, description: desc, image, config_path: config });
      ['hosted-name-input','hosted-host-input','hosted-start-input','hosted-stop-input','hosted-desc-input','hosted-image-input','hosted-config-input'].forEach(id => { $id(id).value = ''; });
      $id('hosted-port-input').value = '25565';
      toast('Server added');
      renderAdminHosted();
    } catch (err) { toast(err.message, 'error'); }
  });

  // Library filter tabs
  $id('library-filter-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.lib-tab');
    if (!tab) return;
    filterStatus = tab.dataset.status;
    $id('library-filter-tabs').querySelectorAll('.lib-tab').forEach(t =>
      t.classList.toggle('active', t === tab)
    );
    renderLibrary();
  });

  // Hero controls
  $id('hero-prev').addEventListener('click', () => { clearInterval(heroTimer); setHeroSlide(heroIndex - 1); startHeroRotation(); });
  $id('hero-next').addEventListener('click', () => { clearInterval(heroTimer); setHeroSlide(heroIndex + 1); startHeroRotation(); });
  $id('hero-dots').addEventListener('click', e => {
    const dot = e.target.closest('.hero-dot');
    if (!dot) return;
    clearInterval(heroTimer);
    setHeroSlide(parseInt(dot.dataset.i));
    startHeroRotation();
  });
  $id('hero-banner').addEventListener('mouseenter', () => clearInterval(heroTimer));
  $id('hero-banner').addEventListener('mouseleave', () => startHeroRotation());

  // Modal close
  $id('modal-close').addEventListener('click', closeDetailModal);
  $id('game-detail-modal').addEventListener('click', e => {
    if (e.target === $id('game-detail-modal')) closeDetailModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDetailModal(); closeEmulator(); }
  });

  // Emulator close
  $id('emulator-close').addEventListener('click', closeEmulator);
}

// ── Emulators ─────────────────────────────────────────────────────────────────

const EMULATOR_SYSTEMS = [
  { id: 'nes',    name: 'NES',            color: '#E8E8E8', logo: 'img/systems/nes.svg', neon: '#00d8ff' },
  { id: 'snes',   name: 'Super Nintendo', color: '#5B4F9E', neon: '#d0ff00' },
  { id: 'n64',    name: 'Nintendo 64',    color: '#E8823A', neon: '#ff00e1' },
  { id: 'gba',    name: 'Game Boy / GBA', color: '#4CAF82', neon: '#00ff18' },
  { id: 'psx',    name: 'PlayStation',    color: '#00439C', neon: '#ff0000' },
  { id: 'segaMD', name: 'Sega Genesis',   color: '#1A1A2E', neon: '#bf00ff' },
  { id: 'nds',    name: 'Nintendo DS',    color: '#D4A017', neon: '#ff6a00' },
];

let activeEmuSystem = null;

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function renderEmulators() {
  const content = $id('emulators-content');

  if (!activeEmuSystem) {
    // System selection grid
    content.innerHTML = `<div class="emu-systems-grid">${
      EMULATOR_SYSTEMS.map(s => `
        <button class="emu-system-card" data-system="${s.id}" style="--card-neon:${s.neon}">
          <div class="emu-system-icon" style="background:${s.color}">
            ${s.logo
              ? `<img src="${esc(s.logo)}" alt="${esc(s.name)}" style="width:80%;height:80%;object-fit:contain;">`
              : `<svg viewBox="0 0 24 24" fill="none" width="36" height="36">
                  <rect x="2" y="6" width="20" height="14" rx="3" stroke="white" stroke-width="1.5"/>
                  <path d="M8 13h2m-1-1v2M15 13h.01M17 13h.01" stroke="white" stroke-width="2" stroke-linecap="round"/>
                </svg>`
            }
          </div>
          <div class="emu-system-name" style="color:#fff;text-shadow:0 0 4px #fff,0 0 10px ${s.neon},0 0 24px ${s.neon},0 0 48px ${s.neon}88;">${esc(s.name)}</div>
          <div class="emu-system-count" id="emu-count-${s.id}">—</div>
        </button>`
      ).join('')
    }</div>`;

    content.querySelectorAll('.emu-system-card').forEach(card => {
      card.addEventListener('click', () => { activeEmuSystem = card.dataset.system; renderEmulators(); });
    });

    // Load ROM counts in background
    api('GET', '/api/roms').then(allRoms => {
      EMULATOR_SYSTEMS.forEach(s => {
        const el = $id(`emu-count-${s.id}`);
        if (el) {
          const n = allRoms.filter(r => r.system === s.id).length;
          el.textContent = n + ' ROM' + (n !== 1 ? 's' : '');
        }
      });
    }).catch(() => {});

  } else {
    // ROM list for selected system
    const sys = EMULATOR_SYSTEMS.find(s => s.id === activeEmuSystem);
    let emuRoms = [];
    try { emuRoms = await api('GET', `/api/roms?system=${encodeURIComponent(activeEmuSystem)}`); } catch {}
    const isAdmin = currentUser?.role === 'admin';

    content.innerHTML = `
      <div class="emu-list-header">
        <button class="btn btn-ghost btn-sm" id="emu-back">← Back</button>
        <h3 class="emu-list-title">${esc(sys?.name || activeEmuSystem)}</h3>
        ${isAdmin ? `
          <label class="btn btn-accent btn-sm" for="emu-upload-input" style="cursor:pointer">Upload ROM</label>
          <input type="file" id="emu-upload-input" accept=".nes,.sfc,.smc,.z64,.n64,.v64,.gb,.gbc,.gba,.bin,.iso,.md,.smd,.gen,.nds" style="display:none">
        ` : '<div></div>'}
      </div>
      <div id="emu-rom-list">${
        !emuRoms.length
          ? `<div class="empty-state"><strong>No ROMs yet.</strong>${isAdmin ? '<p>Upload a ROM file to get started.</p>' : ''}</div>`
          : emuRoms.map(rom => `
              <div class="emu-rom-item">
                <div class="emu-rom-icon">
                  <svg viewBox="0 0 20 20" fill="none" width="18" height="18"><rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M7 8h6M7 11h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                </div>
                <div class="emu-rom-info">
                  <div class="emu-rom-name">${esc(rom.name)}</div>
                  <div class="emu-rom-meta">${formatFileSize(rom.size)}</div>
                </div>
                <div class="emu-rom-actions">
                  <button class="btn btn-accent btn-sm emu-play-btn" data-id="${esc(rom.id)}" data-name="${esc(rom.name)}">▶ Play</button>
                  ${isAdmin ? `<button class="btn btn-danger btn-sm emu-del-btn" data-id="${esc(rom.id)}" style="margin-left:6px">Del</button>` : ''}
                </div>
              </div>`
          ).join('')
      }</div>`;

    $id('emu-back').addEventListener('click', () => { activeEmuSystem = null; renderEmulators(); });

    if (isAdmin && $id('emu-upload-input')) {
      $id('emu-upload-input').addEventListener('change', uploadRom);
    }

    content.querySelectorAll('.emu-play-btn').forEach(btn => {
      btn.addEventListener('click', () => launchEmulator(btn.dataset.id, btn.dataset.name));
    });

    if (isAdmin) {
      content.querySelectorAll('.emu-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this ROM? This cannot be undone.')) return;
          try {
            await api('DELETE', `/api/roms/${btn.dataset.id}`);
            toast('ROM deleted');
            renderEmulators();
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    }
  }
}

async function uploadRom() {
  const file = $id('emu-upload-input').files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('rom', file);
  formData.append('system', activeEmuSystem);
  formData.append('name', file.name.replace(/\.[^.]+$/, ''));
  try {
    const res = await fetch('/api/roms', {
      method: 'POST',
      headers: { 'x-hub-session': token || '' },
      body: formData,
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Upload failed'); }
    toast('ROM uploaded', 'success');
    renderEmulators();
  } catch (err) { toast(err.message, 'error'); }
}

function launchEmulator(romId, romName) {
  const url = `/emulator.html?core=${encodeURIComponent(activeEmuSystem)}&rom=${encodeURIComponent(`/api/roms/${romId}/file`)}`;
  $id('emulator-title').textContent = romName || 'Emulator';
  $id('emulator-frame').src = url;
  $id('emulator-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeEmulator() {
  const overlay = $id('emulator-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  overlay.classList.add('hidden');
  $id('emulator-frame').src = '';
  document.body.style.overflow = '';
  activeEmuSystem = null;
  renderEmulators();
}
window.closeEmulator = closeEmulator;

// ── Hosted Servers ────────────────────────────────────────────────────────────

function startHostedPoll() {
  stopHostedPoll();
  hostedPollTimer = setInterval(() => {
    if (activeView !== 'hosted') { stopHostedPoll(); return; }
    renderHosted();
  }, 15000);
}

function stopHostedPoll() {
  clearInterval(hostedPollTimer);
  hostedPollTimer = null;
}

async function renderHosted() {
  const grid = $id('hosted-grid');
  if (!grid) return;
  try { hostedServers = await api('GET', '/api/hosted'); }
  catch { grid.innerHTML = '<div class="empty-state">Could not load servers.</div>'; return; }

  if (!hostedServers.length) {
    grid.innerHTML = '<div class="empty-state"><strong>No servers configured.</strong><p>Add a server in the Admin → Hosted Servers tab.</p></div>';
    return;
  }

  const isAdmin = currentUser && currentUser.role === 'admin';

  grid.innerHTML = hostedServers.map(s => `
    <div class="server-tile${s.online ? ' server-tile--online' : ''}" data-id="${esc(s.id)}">
      <div class="server-tile-bg" ${s.image ? `style="background-image:url('${esc(s.image)}')"` : ''}></div>
      <div class="server-tile-scrim"></div>
      <div class="server-tile-body">
        <div class="server-tile-info">
          <div class="server-tile-status">
            <span class="server-tile-badge ${s.online ? 'server-tile-badge--online' : 'server-tile-badge--offline'}">
              ${s.online ? '● ONLINE' : '○ OFFLINE'}
            </span>
          </div>
          <div class="server-tile-name">${esc(s.name)}</div>
          ${s.description ? `<div class="server-tile-desc">${esc(s.description)}</div>` : ''}
          <div class="server-tile-meta">${esc(s.host)}:${s.port}</div>
        </div>
        <div class="server-tile-controls">
          ${isAdmin ? `
          <button class="server-power-btn ${s.online ? 'server-power-btn--on' : 'server-power-btn--off'}" data-id="${esc(s.id)}" data-online="${s.online}" title="${s.online ? 'Stop server' : 'Start server'}">
            <img src="img/servers/${s.online ? 'power-on' : 'power-off'}.svg" alt="${s.online ? 'Stop' : 'Start'}">
            <span>${s.online ? 'Running' : 'Stopped'}</span>
          </button>
          ` : `
          <div class="server-power-display">
            <img src="img/servers/${s.online ? 'power-on' : 'power-off'}.svg" alt="">
          </div>
          `}
          ${isAdmin && s.config_path ? `
          <button class="server-tile-cfg-btn" data-id="${esc(s.id)}">⚙ Settings</button>
          ` : ''}
        </div>
      </div>
      ${isAdmin && s.config_path ? `
      <div class="server-tile-cfg hidden" data-cfg-id="${esc(s.id)}">
        <div class="server-cfg-loading">Loading settings…</div>
      </div>
      ` : ''}
    </div>
  `).join('');

  // Power button handlers
  if (isAdmin) {
    grid.querySelectorAll('.server-power-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const isOn = btn.dataset.online === 'true';
        btn.disabled = true;
        btn.classList.add('server-power-btn--busy');
        try {
          await api('POST', `/api/hosted/${id}/${isOn ? 'stop' : 'start'}`);
          toast(isOn ? 'Stop command sent' : 'Start command sent');
          setTimeout(() => renderHosted(), 3000);
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
          btn.classList.remove('server-power-btn--busy');
        }
      });
    });

    // Settings toggle
    grid.querySelectorAll('.server-tile-cfg-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const panel = grid.querySelector(`.server-tile-cfg[data-cfg-id="${id}"]`);
        if (!panel) return;
        const isOpen = !panel.classList.contains('hidden');
        if (isOpen) { panel.classList.add('hidden'); btn.textContent = '⚙ Settings'; return; }
        panel.classList.remove('hidden');
        btn.textContent = '⚙ Hide Settings';
        if (panel.querySelector('.server-cfg-loading')) {
          try {
            const cfg = await api('GET', `/api/hosted/${id}/config`);
            panel.innerHTML = renderCfgPanel(id, cfg);
            bindCfgSave(panel, id);
          } catch { panel.innerHTML = '<div class="server-cfg-error">Could not load config.</div>'; }
        }
      });
    });
  }
}

function renderCfgPanel(_id, cfg) {
  const val = k => esc(cfg[k] ?? '');
  const tog = (k, label) => `
    <label class="cfg-toggle-row">
      <span class="cfg-label">${label}</span>
      <label class="cfg-switch">
        <input type="checkbox" class="cfg-chk" data-key="${k}" ${cfg[k] === 'true' ? 'checked' : ''}>
        <span class="cfg-switch-track"><span class="cfg-switch-thumb"></span></span>
      </label>
    </label>`;
  return `
    <div class="server-cfg-panel">
      <div class="server-cfg-grid">
        <div class="cfg-field">
          <label class="cfg-label">Difficulty</label>
          <select class="cfg-select" data-key="difficulty">
            ${['peaceful','easy','normal','hard'].map(d => `<option value="${d}" ${cfg.difficulty===d?'selected':''}>${d.charAt(0).toUpperCase()+d.slice(1)}</option>`).join('')}
          </select>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Game Mode</label>
          <select class="cfg-select" data-key="gamemode">
            ${['survival','creative','adventure','spectator'].map(d => `<option value="${d}" ${cfg.gamemode===d?'selected':''}>${d.charAt(0).toUpperCase()+d.slice(1)}</option>`).join('')}
          </select>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Max Players</label>
          <input class="cfg-input" type="number" data-key="max-players" value="${val('max-players')}" min="1" max="500">
        </div>
        <div class="cfg-field">
          <label class="cfg-label">View Distance</label>
          <input class="cfg-input" type="number" data-key="view-distance" value="${val('view-distance')}" min="2" max="32">
        </div>
        <div class="cfg-field cfg-field--full">
          <label class="cfg-label">MOTD</label>
          <input class="cfg-input" type="text" data-key="motd" value="${val('motd')}">
        </div>
        ${tog('white-list','Whitelist')}
        ${tog('pvp','PvP')}
        ${tog('enable-command-block','Command Blocks')}
        ${tog('online-mode','Online Mode')}
        ${tog('allow-flight','Allow Flight')}
        ${tog('spawn-monsters','Spawn Monsters')}
      </div>
      <div class="server-cfg-footer">
        <button class="btn btn-accent cfg-save-btn">Save Changes</button>
        <span class="cfg-save-status"></span>
      </div>
    </div>`;
}

function bindCfgSave(panel, id) {
  panel.querySelector('.cfg-save-btn').addEventListener('click', async () => {
    const changes = {};
    panel.querySelectorAll('[data-key]').forEach(el => {
      changes[el.dataset.key] = el.type === 'checkbox' ? String(el.checked) : el.value;
    });
    const status = panel.querySelector('.cfg-save-status');
    status.textContent = 'Saving…';
    try {
      await api('PATCH', `/api/hosted/${id}/config`, changes);
      status.textContent = '✓ Saved — restart server to apply';
      status.style.color = 'var(--success)';
      setTimeout(() => { status.textContent = ''; }, 4000);
    } catch (err) {
      status.textContent = '✗ ' + err.message;
      status.style.color = 'var(--danger)';
    }
  });
}

async function renderAdminHosted() {
  const list = $id('admin-hosted-list');
  if (!list) return;
  const servers = await api('GET', '/api/hosted').catch(() => []);
  if (!servers.length) {
    list.innerHTML = '<div class="empty-state">No servers yet.</div>';
    return;
  }
  list.innerHTML = `<div class="admin-lookup-list">${servers.map(s => `
    <div class="admin-lookup-item" style="flex-direction:column;align-items:flex-start;gap:2px">
      <div style="display:flex;align-items:center;gap:8px;width:100%">
        <strong>${esc(s.name)}</strong>
        <span style="color:var(--text-3);font-size:11px">${esc(s.host)}:${s.port}</span>
        <span style="margin-left:auto;color:${s.online ? 'var(--accent)' : 'var(--text-3)'};">${s.online ? '● Online' : '○ Offline'}</span>
        <button class="admin-lookup-delete" data-id="${esc(s.id)}" title="Delete">×</button>
      </div>
      ${s.description ? `<div style="font-size:11px;color:var(--text-3)">${esc(s.description)}</div>` : ''}
      <div style="font-size:11px;color:var(--text-3)">Start: <code>${esc(s.start_command || '—')}</code> &nbsp; Stop: <code>${esc(s.stop_command || '—')}</code></div>
      ${s.config_path ? `<div style="font-size:11px;color:var(--text-3)">Config: <code>${esc(s.config_path)}</code></div>` : ''}
      ${s.image ? `<div style="font-size:11px;color:var(--text-3)">Image: <code>${esc(s.image)}</code></div>` : ''}
    </div>
  `).join('')}</div>`;
  list.querySelectorAll('.admin-lookup-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const s = servers.find(x => x.id === btn.dataset.id);
      if (!confirm(`Delete "${s?.name}"?`)) return;
      await api('DELETE', `/api/hosted/${btn.dataset.id}`);
      renderAdminHosted();
    });
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();

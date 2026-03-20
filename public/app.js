'use strict';

// ── Hub URL ───────────────────────────────────────────────────────────────────

function getHubUrl() {
  const h = window.location.hostname;
  return (h === 'localhost' || h === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(h))
    ? `http://${h}:3000`
    : 'https://kitkatdacat.com';
}

// ── State ─────────────────────────────────────────────────────────────────────

const _urlToken = new URLSearchParams(window.location.search).get('hubToken');
if (_urlToken) localStorage.setItem('tkn_games', _urlToken);

let token           = localStorage.getItem('tkn_games') || null;
{ const _c = localStorage.getItem('profile_neon') || '#ff8c00';
  document.documentElement.style.setProperty('--profile-neon', _c === 'rainbow' ? '#00d8ff' : _c);
  if (_c === 'rainbow') document.documentElement.setAttribute('data-profile', 'rainbow'); }
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
const heroDotColors = ['#00d8ff', '#d0ff00', '#ff00e1', '#00ff18', '#ff0000', '#ff8c00'];
let editingGameId   = null;   // null = creating new
let pendingRomId    = null;   // ROM uploaded but not yet saved to a game
let gfDoSearch      = null;   // set by renderGameForm when adding a new game
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

// ── applyDataStyles ────────────────────────────────────────────────────────────
// Converts data-s-* attributes to inline style properties (CSP-safe DOM assignment)

function applyDataStyles(root) {
  const each = (attr, fn) => {
    if (root.hasAttribute && root.hasAttribute(`data-s-${attr}`)) {
      fn(root, root.getAttribute(`data-s-${attr}`));
      root.removeAttribute(`data-s-${attr}`);
    }
    root.querySelectorAll(`[data-s-${attr}]`).forEach(el => {
      fn(el, el.getAttribute(`data-s-${attr}`));
      el.removeAttribute(`data-s-${attr}`);
    });
  };
  [['nl','--nl'],['sw','--sw'],['dc','--dc'],['sc','--sc'],['ct','--ct'],
   ['card-neon','--card-neon'],['sys-neon','--sys-neon']].forEach(([attr, prop]) => {
    each(attr, (el, v) => el.style.setProperty(prop, v));
  });
  each('bg',      (el, v) => { el.style.background = v; });
  each('bg-img',  (el, v) => { el.style.backgroundImage = `url('${v}')`; });
  each('border',  (el, v) => { el.style.borderColor = v; });
  each('color',   (el, v) => { el.style.color = v; });
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('games-theme', t);
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
  applyDataStyles(document.body);

  if (currentUser.role === 'admin') {
    $id('dd-admin').classList.remove('hidden');
  } else {
    $id('nav-controls').classList.add('hidden');
  }

  // Load profile color from hub preferences
  try {
    const prefs = await fetch(`${getHubUrl()}/api/user/preferences`, {
      headers: { 'x-hub-session': token || '' },
    }).then(r => r.ok ? r.json() : {});
    if (prefs.profileNeon) {
      localStorage.setItem('profile_neon', prefs.profileNeon);
      applyProfileNeon(prefs.profileNeon);
    }
  } catch {}

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

function applyProfileNeon(color) {
  const isRainbow = color === 'rainbow';
  // For rainbow, cycle through the neon colors for text/icon elements
  document.documentElement.style.setProperty('--profile-neon', isRainbow ? '#00d8ff' : color);
  document.documentElement.setAttribute('data-profile', isRainbow ? 'rainbow' : '');
  document.querySelectorAll('.dd-swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.color === color)
  );
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
    const _neons = ['#00d8ff','#d0ff00','#ff00e1','#00ff18','#ff0000','#ff8c00'];
    const _isRainbow = document.documentElement.getAttribute('data-profile') === 'rainbow';
    let _ni = 0;
    const n = v => {
      const color = _isRainbow ? _neons[_ni++ % _neons.length] : 'var(--profile-neon,#ff8c00)';
      return `<span class="dd-stat-val" data-s-color="${color}">${v}</span>`;
    };
    if (el) {
      el.innerHTML =
        `<div>${n(stats.total)} game${stats.total !== 1 ? 's' : ''} in library</div>` +
        `<div>${n(formatPlaytime(stats.totalPlaytimeMin))} played</div>` +
        `<div>${n(stats.byStatus.playing || 0)} playing · ${n(stats.byStatus.completed || 0)} completed</div>`;
      applyDataStyles(el);
    }
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

async function cleanupPendingRom() {
  if (!pendingRomId) return;
  const id = pendingRomId;
  pendingRomId = null;
  try { await api('DELETE', `/api/roms/${id}`); } catch {}
}

async function switchView(name) {
  cleanupPendingRom();
  activeView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.querySelector(`.view[data-view="${name}"]`);
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('nav-item--active', n.dataset.view === name);
  });
  await refreshData();
  if (name !== 'controls')  stopGamepadPoll();
  if (name === 'home')      renderHome();
  if (name === 'library')   renderLibrary();
  if (name === 'search')    renderSearch();
  if (name === 'admin')     renderAdmin();
  if (name === 'hosted')    { renderHosted(); startHostedPoll(); }
  if (name !== 'hosted')    stopHostedPoll();
  if (name === 'emulators') { activeEmuSystem = null; renderEmulators(); }
  if (name === 'controls')  renderControls();
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
  const el = $id('hero-dots');
  el.innerHTML = heroGames.map((_, i) =>
    `<button class="hero-dot${i === 0 ? ' active' : ''}" data-i="${i}" data-s-dc="${heroDotColors[i % heroDotColors.length]}"></button>`
  ).join('');
  applyDataStyles(el);
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
  const heroColor = heroDotColors[heroIndex % heroDotColors.length];
  document.querySelectorAll('.hero-arrow').forEach(a => {
    a.style.color = heroColor;
    a.style.filter = `drop-shadow(0 0 4px ${heroColor})`;
    a.style.boxShadow = `0 0 10px ${heroColor}4d, inset 0 0 6px ${heroColor}0d`;
  });
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
  if (heroGames.length > 1) heroTimer = setInterval(() => setHeroSlide(heroIndex + 1), 12000);
}

// ── Shelf System ──────────────────────────────────────────────────────────────

function renderHome() {
  renderHero();
  const container = $id('shelves-container');
  container.innerHTML = '';

  const gamesInStatus = s => games.filter(g => g.libraryEntry?.status === s);
  const newestGames   = games.slice().sort((a,b) => b.created_at?.localeCompare(a.created_at)).slice(0, 20);
  const topRated      = games.slice().sort((a,b) => (b.metacritic||0) - (a.metacritic||0)).filter(g => g.metacritic).slice(0, 20);
  const recentlyPlayed = games.filter(g => g.last_played_at).sort((a,b) => b.last_played_at.localeCompare(a.last_played_at)).slice(0, 20);
  const classics      = games.filter(g => g.release_year && g.release_year <= 2000).sort((a,b) => (b.metacritic||0) - (a.metacritic||0));

  const genreShelves = [...new Set(games.flatMap(g => g.genres || []))].sort().map(genre => ({
    id: `genre-${genre.toLowerCase().replace(/\s+/g,'-')}`,
    label: genre,
    list: games.filter(g => (g.genres || []).includes(genre)),
  }));

  const platformShelves = [...new Set(games.flatMap(g => g.platforms || []))].sort().map(platform => ({
    id: `platform-${platform.toLowerCase().replace(/\s+/g,'-')}`,
    label: platform,
    list: games.filter(g => (g.platforms || []).includes(platform)),
  }));

  const shelves = [
    { id: 'continue',        label: 'Continue Playing',   list: gamesInStatus('playing') },
    { id: 'new',             label: 'New to the Catalog', list: newestGames },
    { id: 'recently-played', label: 'Recently Played',    list: recentlyPlayed },
    { id: 'backlog',         label: 'Your Backlog',        list: gamesInStatus('backlog') },
    { id: 'top-rated',       label: 'Top Rated',           list: topRated },
    { id: 'classics',        label: 'Classic Games',       list: classics },
    { id: 'completed',       label: 'Completed',           list: gamesInStatus('completed') },
    ...genreShelves,
    ...platformShelves,
    { id: 'all',             label: 'All Games',           list: games },
  ];

  const neonColors = ['#00d8ff', '#d0ff00', '#ff00e1', '#00ff18', '#ff0000'];
  let colorIdx = 0;
  for (const s of shelves) {
    const alwaysShow = ['backlog', 'recently-played', 'new'].includes(s.id);
    if (alwaysShow ? s.list.length === 0 : s.list.length < 6) continue;
    container.insertAdjacentHTML('beforeend', renderShelf(s.id, s.label, s.list.slice(0, 15), neonColors[colorIdx % neonColors.length], s.list.length));
    colorIdx++;
  }

  applyDataStyles(container);

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
  // Show arrows only when the track actually overflows
  container.querySelectorAll('.shelf-track').forEach(track => {
    const updateArrows = () => {
      const overflows = track.scrollWidth > track.clientWidth + 2;
      track.closest('.shelf').querySelectorAll('.shelf-arrow').forEach(a => a.style.display = overflows ? '' : 'none');
    };
    updateArrows();
    new ResizeObserver(updateArrows).observe(track);
  });

  container.querySelectorAll('.shelf-see-all').forEach(btn => {
    btn.addEventListener('click', () => switchView('library'));
  });
  attachCardClicks(container);
}

function renderShelf(id, label, list, color = '#00d8ff', total = list.length) {
  return `
    <section class="shelf" id="shelf-${id}">
      <div class="shelf-header">
        <h2 class="shelf-title" data-s-color="${color}">${esc(label)}</h2>
        ${total > 15 ? '<button class="shelf-see-all">See All</button>' : ''}
      </div>
      <button class="shelf-arrow shelf-arrow--left" data-s-sc="${color}">&#8249;</button>
      <div class="shelf-track" id="shelf-track-${id}">
        ${list.map(renderGameCard).join('')}
      </div>
      <button class="shelf-arrow shelf-arrow--right" data-s-sc="${color}">&#8250;</button>
    </section>`;
}

// ── Game Card ─────────────────────────────────────────────────────────────────

function renderGameCard(g, showStatus = false, showLibBtn = false) {
  const status  = showStatus ? (g.libraryEntry?.status || g.status || '') : '';
  const inLib   = !!g.libraryEntry;
  const mc      = g.metacritic;
  const chips   = (g.platforms || []).slice(0, 2).map(p => `<span class="chip chip-xs">${esc(p)}</span>`).join('');
  const mcBadge = mc ? `<span class="game-card-mc ${mcColor(mc)}">${mc}</span>` : '';
  const badge   = status ? `<div class="game-card-badge">${esc(statusLabel(status))}</div>` : '';
  const libBtn  = showLibBtn ? `<button class="card-lib-btn${inLib ? ' in-library' : ''}" data-lib="${esc(g.id)}">${inLib ? '— Remove' : '+ Add'}</button>` : '';
  const coverAttr = g.cover_url ? ` data-s-bg-img="${g.cover_url.replace(/'/g, '%27')}"` : '';
  const noCoverCls = g.cover_url ? '' : ' game-card--no-cover';

  return `
    <div class="game-card${status ? ' status-' + status : ''}${noCoverCls}" data-id="${esc(g.id)}"${coverAttr}>
      ${libBtn}
      ${badge}
      ${mcBadge ? `<div class="game-card-mc-corner">${mcBadge}</div>` : ''}
      ${!g.cover_url ? `<div class="game-card-no-cover">${esc(g.title)}</div>` : ''}
      <div class="game-card-overlay">
        <div class="game-card-title">${esc(g.title)}</div>
        <div class="game-card-dev">${esc(g.developer || '')}</div>
        <div class="game-card-chips">${chips}</div>
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
        btn.textContent = adding ? '— Remove' : '+ Add';
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
    applyDataStyles(grid);
    attachCardClicks(grid);
  }

  const total = games.filter(g => g.libraryEntry).length;
  $id('library-stats-bar').innerHTML = total
    ? `<span class="lib-count">${total}</span> <span class="stats-label">game${total !== 1 ? 's' : ''} in your library</span>`
    : '<span class="stats-label">Your library is empty.</span>';
}

// ── Browse / Search View ──────────────────────────────────────────────────────

function renderSearch() {
  renderFilterStrips();
  applySearchFilter();
}

function renderFilterStrips() {
  const usedGenres    = new Set(games.flatMap(g => g.genres || []));
  const usedPlatforms = new Set(games.flatMap(g => g.platforms || []));

  $id('genre-filter-strip').innerHTML =
    `<button class="filter-chip${!filterGenre ? ' active' : ''}" data-type="genre" data-val="">All Genres</button>` +
    genres.filter(g => usedGenres.has(g.name)).map(g =>
      `<button class="filter-chip${filterGenre === g.name ? ' active' : ''}" data-type="genre" data-val="${esc(g.name)}">${esc(g.name)}</button>`
    ).join('');

  $id('platform-filter-strip').innerHTML =
    `<button class="filter-chip${!filterPlatform ? ' active' : ''}" data-type="platform" data-val="">All Platforms</button>` +
    platforms.filter(p => usedPlatforms.has(p.name)).map(p =>
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
    applyDataStyles(grid);
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
    mcBadge.classList.remove('hidden');
  } else { mcBadge.classList.add('hidden'); }

  $id('modal-title').textContent = game.title;

  // Meta row
  const _metaLine1 = [
    game.release_year ? `<span class="modal-meta-item">${game.release_year}</span>` : '',
    game.publisher && game.publisher !== game.developer ? `<span class="modal-meta-item">${esc(game.publisher)}</span>` : '',
    game.rating_esrb  ? `<span class="chip">${esc(game.rating_esrb)}</span>` : '',
  ].filter(Boolean).join('<span class="modal-meta-item meta-sep">·</span>');
  const _metaLine2 = game.developer ? `<span class="modal-meta-item modal-meta-dev">by ${esc(game.developer)}</span>` : '';
  $id('modal-meta-row').innerHTML = [_metaLine1, _metaLine2].filter(Boolean).join('<br>');

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
    `<button type="button" class="star-btn" data-n="${i + 1}">★</button>`
  ).join('');

  const btns = Array.from(container.querySelectorAll('.star-btn'));

  function paint(val) {
    btns.forEach((b, i) => {
      const on = i + 1 <= val;
      b.style.color = on ? '#d0ff00' : 'rgba(255,255,255,0.5)';
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
        <span class="review-stars"><span class="review-stars-filled">${'★'.repeat(r.rating)}</span><span class="review-stars-empty">${'☆'.repeat(5 - r.rating)}</span></span>
        <span class="review-date">${timeAgo(r.created_at)}</span>
      </div>
      <div class="review-body">${esc(r.body)}</div>
    </div>`).join('') : `<p class="no-reviews-msg">No reviews yet.</p>`;

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
    applyDataStyles(newEl);
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
        <span class="session-progress">Session in progress…</span>
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

  // Manual session form (optional — elements may not be present)
  const addSessionBtn = $id('modal-add-session-btn');
  const saveSessionBtn = $id('ms-save-btn');
  if (addSessionBtn) {
    addSessionBtn.onclick = () => $id('modal-manual-session')?.classList.toggle('hidden');
  }
  if (saveSessionBtn) {
    saveSessionBtn.onclick = async () => {
      const start = $id('ms-start').value;
      const end   = $id('ms-end').value;
      if (!start || !end) { toast('Fill in start and end times', 'error'); return; }
      const dur = Math.max(0, Math.floor((new Date(end) - new Date(start)) / 60000));
      const notes = $id('ms-notes').value;
      try {
        await api('POST', `/api/games/${game.id}/sessions`, { started_at: new Date(start).toISOString(), ended_at: new Date(end).toISOString(), duration_min: dur, notes });
        $id('modal-manual-session')?.classList.add('hidden');
        $id('ms-start').value = ''; $id('ms-end').value = ''; $id('ms-notes').value = '';
        await loadModalPlaytime(game);
        toast('Session added', 'success');
      } catch (err) { toast(err.message, 'error'); }
    };
  }
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
  const home = $id('games-admin-home');
  const sub  = $id('games-admin-sub');
  if (!home || !sub) return;

  // Show home grid, hide sub-panel
  home.classList.remove('hidden');
  sub.classList.add('hidden');

  // Wire nav cards
  home.querySelectorAll('.games-admin-nav-card').forEach(card => {
    // Clone to remove any prior listeners
    const fresh = card.cloneNode(true);
    card.parentNode.replaceChild(fresh, card);
    fresh.addEventListener('click', () => switchAdminTab(fresh.dataset.atab));
  });

  // Wire back button
  const backBtn = $id('games-admin-back');
  if (backBtn) {
    const freshBack = backBtn.cloneNode(true);
    backBtn.parentNode.replaceChild(freshBack, backBtn);
    freshBack.addEventListener('click', () => {
      sub.classList.add('hidden');
      home.classList.remove('hidden');
    });
  }
}

function switchAdminTab(name) {
  cleanupPendingRom();
  const home = $id('games-admin-home');
  const sub  = $id('games-admin-sub');
  if (!home || !sub) return;

  // Navigate home → sub
  home.classList.add('hidden');
  sub.classList.remove('hidden');

  // Carry the card's neon color into the sub-panel
  const neonColors = {
    'catalog': '#00d8ff',
    'add-game': '#d0ff00',
    'genres': '#ff00e1',
    'platforms': '#00ff18',
    'hosted-servers': '#ff8c00',
  };
  const neon = neonColors[name] || '#00d8ff';
  sub.style.setProperty('--sub-neon', neon);

  // Set sub-panel title
  const titles = {
    'catalog': 'Catalog',
    'add-game': 'Add Game',
    'genres': 'Genres',
    'platforms': 'Platforms',
    'hosted-servers': 'Hosted Servers',
  };
  const titleEl = $id('games-admin-sub-title');
  if (titleEl) titleEl.textContent = titles[name] || name;

  // Show correct panel
  document.querySelectorAll('.admin-tab-panel').forEach(p =>
    p.classList.toggle('hidden', p.id !== `admin-tab-${name}`)
  );

  if (name === 'catalog')        renderAdminCatalog();
  if (name === 'add-game')       renderGameForm(null);
  if (name === 'genres')         renderGenresAdmin();
  if (name === 'platforms')      renderPlatformsAdmin();
  if (name === 'hosted-servers') renderAdminHosted();
}

function renderAdminCatalog(query = '') {
  const wrap = $id('admin-game-table-wrap');
  const filtered = (query
    ? games.filter(g => g.title.toLowerCase().includes(query.toLowerCase()) ||
                        (g.developer || '').toLowerCase().includes(query.toLowerCase()))
    : [...games]
  ).sort((a, b) => a.title.localeCompare(b.title));

  wrap.innerHTML = `
    <div class="catalog-toolbar">
      <input id="admin-catalog-search" class="admin-catalog-search flex-1" type="search" placeholder="Search games…"
        value="${esc(query)}" />
      <button class="btn btn-danger btn-sm catalog-delete-selected hidden" id="catalog-delete-selected">
        Delete Selected (<span id="catalog-selected-count">0</span>)
      </button>
    </div>
    ${!filtered.length ? `<div class="empty-state"><strong>${games.length ? 'No matches.' : 'No games yet.'}</strong></div>` : `
    <table class="admin-game-table">
      <thead><tr>
        <th><input type="checkbox" id="catalog-select-all" class="catalog-checkbox" title="Select all" /></th>
        <th></th><th>Title</th><th>Developer</th><th>Year</th><th>Platforms</th><th>Metacritic</th><th></th>
      </tr></thead>
      <tbody>
        ${filtered.map(g => `
          <tr data-row-id="${esc(g.id)}">
            <td><input type="checkbox" class="catalog-checkbox catalog-row-check" data-id="${esc(g.id)}" /></td>
            <td>${g.cover_url ? `<img src="${esc(g.cover_url)}" alt="" loading="lazy">` : '<div class="admin-cover-placeholder"></div>'}</td>
            <td><strong>${esc(g.title)}</strong></td>
            <td>${esc(g.developer || '—')}</td>
            <td>${g.release_year || '—'}</td>
            <td>${(g.platforms||[]).slice(0,2).join(', ') || '—'}</td>
            <td>${g.metacritic || '—'}</td>
            <td class="nowrap">
              <button class="btn btn-ghost btn-sm" data-edit="${esc(g.id)}">Edit</button>
              <button class="btn btn-danger btn-sm ml-4" data-del="${esc(g.id)}">Del</button>
            </td>
          </tr>`
        ).join('')}
      </tbody>
    </table>`}`;

  const searchEl = $id('admin-catalog-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => renderAdminCatalog(searchEl.value));
    searchEl.focus();
  }

  // Selection logic
  const updateSelectionUI = () => {
    const checked = wrap.querySelectorAll('.catalog-row-check:checked');
    const count = checked.length;
    const delBtn = $id('catalog-delete-selected');
    const countEl = $id('catalog-selected-count');
    if (delBtn) delBtn.classList.toggle('hidden', count === 0);
    if (countEl) countEl.textContent = count;
    // Highlight selected rows
    wrap.querySelectorAll('tr[data-row-id]').forEach(row => {
      const cb = row.querySelector('.catalog-row-check');
      row.classList.toggle('catalog-row-selected', cb?.checked || false);
    });
  };

  const selectAll = $id('catalog-select-all');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      wrap.querySelectorAll('.catalog-row-check').forEach(cb => { cb.checked = selectAll.checked; });
      updateSelectionUI();
    });
  }

  wrap.querySelectorAll('.catalog-row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      if (selectAll) selectAll.checked = wrap.querySelectorAll('.catalog-row-check:not(:checked)').length === 0;
      updateSelectionUI();
    });
  });

  // Multi-delete
  const delSelectedBtn = $id('catalog-delete-selected');
  if (delSelectedBtn) {
    delSelectedBtn.addEventListener('click', async () => {
      const ids = [...wrap.querySelectorAll('.catalog-row-check:checked')].map(cb => cb.dataset.id);
      if (!ids.length) return;
      if (!confirm(`Delete ${ids.length} game${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
      try {
        await Promise.all(ids.map(id => api('DELETE', `/api/games/${id}`)));
        await refreshData();
        renderAdminCatalog(query);
        toast(`${ids.length} game${ids.length > 1 ? 's' : ''} deleted`);
      } catch (err) { toast(err.message, 'error'); }
    });
  }

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
        renderAdminCatalog(query);
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
    <h3 class="form-heading">${game ? 'Edit' : 'Add'} Game</h3>

    <div class="gf-rom-upload-box">
      <div class="gf-rom-upload-title">ROM Upload</div>
      <div class="gf-rom-upload-row">
        <select id="gf-rom-system" class="gf-rom-select">
          <option value="">— System —</option>
          ${EMULATOR_SYSTEMS.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
        </select>
        <input id="gf-rom-name" class="gf-rom-name-input" placeholder="ROM name…" />
      </div>
      <div class="gf-rom-upload-row mt-8">
        <label class="gf-rom-file-label" for="gf-rom-file">
          <svg viewBox="0 0 20 20" fill="none" width="16" height="16"><path d="M10 3v10M6 7l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 17h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Choose ROM
        </label>
        <input type="file" id="gf-rom-file" class="hidden" />
        <span id="gf-rom-filename" class="gf-rom-filename">No file chosen</span>
        <button class="btn btn-sub-neon btn-sm" id="gf-rom-upload-btn">Upload</button>
      </div>
      <div id="gf-rom-status" class="gf-upload-status"></div>
    </div>

    <div class="gf-upload-row">
      <div class="gf-upload-box" id="gf-cover-upload-box">
        <div class="gf-upload-preview" id="gf-cover-preview">${game?.cover_url ? `<img src="${esc(game.cover_url)}" />` : ''}</div>
        <label class="gf-upload-label" for="gf-cover-file">
          <svg viewBox="0 0 20 20" fill="none" width="20" height="20"><path d="M10 3v10M6 7l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 17h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Cover Image
        </label>
        <input type="file" id="gf-cover-file" accept="image/*" class="hidden" />
        <div class="gf-upload-status" id="gf-cover-status"></div>
      </div>
      <div class="gf-upload-box" id="gf-hero-upload-box">
        <div class="gf-upload-preview gf-upload-preview--wide" id="gf-hero-preview">${game?.hero_url ? `<img src="${esc(game.hero_url)}" />` : ''}</div>
        <label class="gf-upload-label" for="gf-hero-file">
          <svg viewBox="0 0 20 20" fill="none" width="20" height="20"><path d="M10 3v10M6 7l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 17h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Hero / Banner
        </label>
        <input type="file" id="gf-hero-file" accept="image/*" class="hidden" />
        <div class="gf-upload-status" id="gf-hero-status"></div>
      </div>
    </div>

    ${!game ? `<div class="gf-search-block">
      <div class="gf-search-source-row">
        <button class="gf-source-btn active" data-source="rawg">RAWG</button>
        <button class="gf-source-btn" data-source="igdb">IGDB</button>
        <select id="gf-igdb-platform" class="gf-rom-select hidden">
          <option value="18">NES</option>
          <option value="19">SNES</option>
          <option value="4">N64</option>
          <option value="33">GBA</option>
          <option value="7">PlayStation</option>
          <option value="">All Platforms</option>
        </select>
      </div>
      <div class="flex-row-mt8">
        <input id="gf-rawg-search" class="admin-catalog-search flex-1" placeholder="Search to auto-fill…" />
        <button class="btn btn-sub-neon" id="gf-rawg-btn">Search</button>
      </div>
    </div>
    <div id="gf-rawg-results" class="gf-results-grid"></div>` : ''}
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
      <div class="field-wrap"><label>Cover Image URL</label><input id="gf-cover" value="${v('cover_url')}" placeholder="https://… or upload above" /></div>
      <div class="field-wrap"><label>Hero/Banner Image URL</label><input id="gf-hero" value="${v('hero_url')}" placeholder="https://… or upload above" /></div>
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
    <div class="flex-row-mt20">
      <button class="btn btn-sub-neon" id="gf-save">${game ? 'Save Changes' : 'Add Game'}</button>
      ${game ? '<button class="btn btn-ghost" id="gf-cancel">Cancel</button>' : ''}
    </div>
    <div id="gf-error" class="field-error hidden mt-8"></div>`;

  $id('gf-save').onclick = saveGameForm;
  if ($id('gf-cancel')) $id('gf-cancel').onclick = async () => { await cleanupPendingRom(); switchAdminTab('catalog'); };

  // Resize image to at least targetW×targetH (upscale only, preserve aspect ratio)
  function resizeImageFile(file, targetW, targetH) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scaleW = targetW / img.width;
        const scaleH = targetH / img.height;
        const scale  = Math.max(scaleW, scaleH, 1); // never shrink
        const w = Math.round(img.width  * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob => resolve(new File([blob], file.name, { type: 'image/jpeg' })), 'image/jpeg', 0.92);
      };
      img.src = url;
    });
  }

  // Image upload handlers
  function wireImageUpload(fileInputId, previewId, urlInputId, statusId, targetW, targetH) {
    const fileInput = $id(fileInputId);
    const preview   = $id(previewId);
    const urlInput  = $id(urlInputId);
    const status    = $id(statusId);
    if (!fileInput) return;

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      status.textContent = 'Processing…';
      try {
        const resized = await resizeImageFile(file, targetW, targetH);
        status.textContent = 'Uploading…';
        const fd = new FormData();
        fd.append('image', resized);
        const res = await fetch('/api/images', {
          method: 'POST',
          headers: { 'x-hub-session': token || '' },
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        urlInput.value = data.url;
        preview.innerHTML = `<img src="${data.url}" />`;
        status.textContent = '✓ Uploaded';
        setTimeout(() => { status.textContent = ''; }, 2000);
      } catch (err) {
        status.textContent = err.message;
      }
    });
  }

  wireImageUpload('gf-cover-file', 'gf-cover-preview', 'gf-cover', 'gf-cover-status', 600, 900);
  wireImageUpload('gf-hero-file',  'gf-hero-preview',  'gf-hero',  'gf-hero-status',  1920, 1080);

  // ROM file picker label
  const romFileInput = $id('gf-rom-file');
  const romFilename  = $id('gf-rom-filename');
  if (romFileInput) {
    romFileInput.addEventListener('change', () => {
      const f = romFileInput.files[0];
      romFilename.textContent = f ? f.name : 'No file chosen';
      // Auto-fill name from cleaned filename
      const nameInput = $id('gf-rom-name');
      if (nameInput && f) {
        nameInput.value = cleanRomName(f.name);
      }
    });
  }

  // ROM upload button
  const romUploadBtn = $id('gf-rom-upload-btn');
  if (romUploadBtn) {
    romUploadBtn.addEventListener('click', async () => {
      const system = $id('gf-rom-system').value;
      const name   = $id('gf-rom-name').value.trim();
      const file   = $id('gf-rom-file').files[0];
      const status = $id('gf-rom-status');
      if (!system) { status.textContent = 'Select a system first.'; return; }
      if (!name)   { status.textContent = 'Enter a ROM name.'; return; }
      if (!file)   { status.textContent = 'Choose a ROM file.'; return; }
      status.textContent = 'Uploading…';
      try {
        const fd = new FormData();
        fd.append('rom', file);
        fd.append('system', system);
        fd.append('name', name);
        const res = await fetch('/api/roms', {
          method: 'POST',
          headers: { 'x-hub-session': token || '' },
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        await cleanupPendingRom(); // delete previous pending ROM if user re-uploaded
        pendingRomId = data.id;
        // Refresh ROM selector and select the new ROM
        const roms = await api('GET', '/api/roms');
        const sel = $id('gf-rom');
        if (sel) {
          sel.innerHTML = '<option value="">— None —</option>' +
            roms.map(r => `<option value="${r.id}"${r.id === data.id ? ' selected' : ''}>${esc(r.name)} (${r.system})</option>`).join('');
        }
        status.innerHTML = `✓ ROM uploaded — <button class="gf-hint-btn" id="gf-rom-test-btn">Test ROM</button>`;
        $id('gf-rom-test-btn').onclick = () => {
          activeEmuSystem = system;
          launchEmulator(data.id, name);
        };

        // Auto-search IGDB using the ROM name + system
        if (gfDoSearch) {
          const cleanedName = cleanRomName(name);
          const igdbPlatform = systemToIgdbPlatform[system] || '';

          // Switch to IGDB source
          document.querySelectorAll('.gf-source-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.source === 'igdb');
          });
          searchSource = 'igdb';
          const platformSel = $id('gf-igdb-platform');
          if (platformSel) { platformSel.value = igdbPlatform; platformSel.classList.remove('hidden'); }
          $id('gf-rawg-search').value = cleanedName;
          gfDoSearch();
        }
      } catch (err) { $id('gf-rom-status').textContent = err.message; }
    });
  }

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

  const systemToIgdbPlatform = { nes:'18', snes:'19', n64:'4', gba:'33', psx:'7', segaMD:'29', nds:'20' };
  let searchSource = 'rawg';

  function cleanRomName(filename) {
    return filename
      .replace(/\.[^.]+$/, '')                        // remove extension
      .replace(/\s*\(([A-Z][a-z]*|Rev\s*[\w.]+|v[\d.]+|[UEJF]|UE|USA|Europe|Japan|World|Proto|Beta|Demo|Sample|Unl|Hack|Homebrew|Alt[^)]*)\)/gi, '')
      .replace(/\s*\[[^\]]*\]/g, '')                  // remove [tags]
      .replace(/\s*-\s*(USA|EUR|JPN|JAP|PAL|NTSC)$/i, '')
      .replace(/\s+/g, ' ').trim();
  }

  if (!game) {
    // Source toggle
    document.querySelectorAll('.gf-source-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        searchSource = btn.dataset.source;
        document.querySelectorAll('.gf-source-btn').forEach(b => b.classList.toggle('active', b === btn));
        const platformSel = $id('gf-igdb-platform');
        if (platformSel) platformSel.classList.toggle('hidden', searchSource !== 'igdb');
        $id('gf-rawg-search').placeholder = searchSource === 'igdb' ? 'Search IGDB to auto-fill…' : 'Search RAWG to auto-fill…';
      });
    });

    gfDoSearch = async () => {
      const q = $id('gf-rawg-search').value.trim();
      if (!q) return;
      const resultsEl = $id('gf-rawg-results');
      resultsEl.innerHTML = '<span class="muted-sm">Searching…</span>';

      try {
        let results, source;
        if (searchSource === 'igdb') {
          const platform = $id('gf-igdb-platform')?.value || '';
          results = await api('GET', `/api/igdb/search?q=${encodeURIComponent(q)}${platform ? `&platform=${platform}` : ''}`);
          source = 'igdb';
        } else {
          results = await api('GET', `/api/rawg/search?q=${encodeURIComponent(q)}`);
          source = 'rawg';
        }

        // Score results by name similarity to query
        const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const nq = normalize(q);
        const scored = results.map(r => {
          const nr = normalize(r.name);
          let score = 0;
          if (nr === nq) score = 3;
          else if (nr.startsWith(nq) || nq.startsWith(nr)) score = 2;
          else if (nr.includes(nq) || nq.includes(nr)) score = 1;
          return { ...r, score };
        }).sort((a, b) => b.score - a.score);

        const noneMatch = scored.every(r => r.score === 0);
        const platformSel = $id('gf-igdb-platform');
        const platformActive = source === 'igdb' && platformSel?.value;

        resultsEl.innerHTML = (scored.length ? scored.map((r, i) => {
          const coverUrl = r.cover ? (source === 'igdb' ? 'https:' + r.cover : r.cover) : '';
          const bestMatch = i === 0 && r.score > 0;
          const platforms = (r.platforms || []).slice(0, 2).join(', ');
          return `
          <button class="gf-lookup-result${bestMatch ? ' gf-lookup-best' : ''}"
            data-source="${source}"
            data-id="${source === 'igdb' ? r.id : ''}"
            data-slug="${source === 'rawg' ? (r.slug || '') : ''}">
            <div class="gf-lookup-cover">
              ${coverUrl ? `<img src="${esc(coverUrl)}" />` : '<div class="gf-lookup-no-cover">?</div>'}
            </div>
            <div class="gf-lookup-info">
              ${bestMatch ? '<span class="gf-lookup-badge">Best Match</span>' : ''}
              <div class="gf-lookup-name">${esc(r.name)}</div>
              <div class="gf-lookup-meta">${[r.year, platforms].filter(Boolean).join(' · ')}</div>
            </div>
          </button>`;
        }).join('') : '') +
        (noneMatch || !scored.length ? `<div class="gf-no-match-hint">
          ${scored.length ? "No close matches. " : "No results. "}
          Try editing the search above${platformActive ? ' or <button class="gf-hint-btn" id="gf-clear-platform">remove the platform filter</button>' : ''}.
        </div>` : '');

        const clearPlatBtn = resultsEl.querySelector('#gf-clear-platform');
        if (clearPlatBtn) {
          clearPlatBtn.onclick = () => {
            const platSel = $id('gf-igdb-platform');
            if (platSel) platSel.value = '';
            gfDoSearch();
          };
        }

        resultsEl.querySelectorAll('.gf-lookup-result').forEach(btn => {
          btn.onclick = async () => {
            btn.style.opacity = '0.5';
            let detail;
            if (btn.dataset.source === 'igdb') {
              detail = await api('GET', `/api/igdb/game/${btn.dataset.id}`);
            } else {
              detail = await api('GET', `/api/rawg/game/${btn.dataset.slug}`);
            }
            $id('gf-title').value    = detail.title || '';
            $id('gf-dev').value      = detail.developer || '';
            $id('gf-pub').value      = detail.publisher || '';
            $id('gf-year').value     = detail.release_year || '';
            $id('gf-desc').value     = detail.description || '';
            $id('gf-cover').value    = detail.cover_url || '';
            if (detail.hero_url) $id('gf-hero').value = detail.hero_url;
            $id('gf-genres').value   = (detail.genres || []).join(', ');
            $id('gf-platforms').value= (detail.platforms || []).join(', ');
            if (detail.metacritic) $id('gf-mc').value = detail.metacritic;
            if (detail.rating_esrb) $id('gf-esrb').value = detail.rating_esrb;

            // Show image picker if multiple images available
            const imgs = detail.all_images || [];
            if (imgs.length > 1) {
              resultsEl.innerHTML = `
                <div class="gf-img-picker">
                  <div class="gf-img-picker-label">Click an image to set it as <strong>Cover</strong> or <strong>Hero</strong></div>
                  <div class="gf-img-picker-grid">
                    ${imgs.map((img, i) => `
                      <div class="gf-img-thumb" data-url="${esc(img.url)}" data-type="${img.type}">
                        <img src="${esc(img.url)}" loading="lazy" />
                        <div class="gf-img-thumb-tag">${img.type}</div>
                        <div class="gf-img-thumb-btns">
                          <button class="gf-img-set-btn" data-field="cover">Cover</button>
                          <button class="gf-img-set-btn" data-field="hero">Hero</button>
                        </div>
                      </div>`).join('')}
                  </div>
                  <button class="gf-img-picker-done">Done</button>
                </div>`;

              resultsEl.querySelectorAll('.gf-img-set-btn').forEach(b => {
                b.onclick = e => {
                  e.stopPropagation();
                  const url = b.closest('.gf-img-thumb').dataset.url;
                  if (b.dataset.field === 'cover') $id('gf-cover').value = url;
                  else $id('gf-hero').value = url;
                  resultsEl.querySelectorAll('.gf-img-thumb').forEach(t => t.classList.remove('gf-img-selected-cover','gf-img-selected-hero'));
                  b.closest('.gf-img-thumb').classList.add(`gf-img-selected-${b.dataset.field}`);
                  toast(`${b.dataset.field === 'cover' ? 'Cover' : 'Hero'} image set`, 'success');
                };
              });

              resultsEl.querySelector('.gf-img-picker-done').onclick = () => {
                resultsEl.innerHTML = '';
                $id('gf-rawg-search').value = '';
              };
            } else {
              resultsEl.innerHTML = '';
              $id('gf-rawg-search').value = '';
              toast('Details filled', 'success');
            }
          };
        });
      } catch (err) {
        resultsEl.innerHTML = `<span class="error-sm">${esc(err.message)}</span>`;
      }
    };
    $id('gf-rawg-btn').onclick = gfDoSearch;
    $id('gf-rawg-search').addEventListener('keydown', e => { if (e.key === 'Enter') gfDoSearch(); });
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
    if (pendingRomId && pendingRomId !== payload.rom_id) await cleanupPendingRom();
    else pendingRomId = null;
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

  // Browse search (moved into search view)
  const searchInput = $id('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(e => {
      searchQuery = e.target.value.trim();
      applySearchFilter();
    }, 300));
  }

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

  // Help
  $id('dd-help').addEventListener('click', () => {
    $id('user-dropdown').classList.add('hidden');
    window.open(`${getHubUrl()}/help/games/`, '_blank');
  });

  // Leave to Hub / Admin
  $id('dd-leave').addEventListener('click', () => {
    window.location.href = getHubUrl();
  });
  $id('dd-admin').addEventListener('click', () => {
    $id('user-dropdown').classList.add('hidden');
    switchView('admin');
  });

  // Personalize — toggle color picker
  $id('dd-personalize').addEventListener('click', () => {
    $id('dd-color-picker').classList.toggle('hidden');
  });

  // Color swatches
  const savedProfileNeon = localStorage.getItem('profile_neon') || '#ff8c00';
  applyProfileNeon(savedProfileNeon);

  document.querySelectorAll('.dd-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      const color = swatch.dataset.color;
      applyProfileNeon(color);
      localStorage.setItem('profile_neon', color);
      fetch(`${getHubUrl()}/api/user/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-hub-session': token || '' },
        body: JSON.stringify({ profileNeon: color }),
      }).catch(() => {});
      $id('dd-color-picker').classList.add('hidden');
    });
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
  { id: 'nes',    name: 'NES',            color: '#E8E8E8', logo: 'img/systems/nes.svg', neon: '#00d8ff', desc: 'Nintendo Entertainment System (1983) — the console that revived the gaming industry. Runs via EmulatorJS (Nestopia core).' },
  { id: 'snes',   name: 'Super Nintendo', color: '#5B4F9E', neon: '#d0ff00', desc: 'Super Nintendo Entertainment System (1990) — home to legendary RPGs and platformers. Runs via EmulatorJS (Snes9x core).' },
  { id: 'n64',    name: 'Nintendo 64',    color: '#E8823A', neon: '#ff00e1', desc: 'Nintendo 64 (1996) — Nintendo\'s first 3D console. Runs via EmulatorJS (Mupen64Plus core).' },
  { id: 'gba',    name: 'Game Boy / GBA', color: '#4CAF82', neon: '#00ff18', desc: 'Game Boy, Game Boy Color & Game Boy Advance (1989–2001) — Nintendo\'s iconic handheld line. Runs via EmulatorJS (mGBA core).' },
  { id: 'psx',    name: 'PlayStation',    color: '#00439C', neon: '#ff0000', desc: 'Sony PlayStation (1994) — Sony\'s debut console that defined a generation. Runs via EmulatorJS (Beetle PSX core).' },
  { id: 'segaMD', name: 'Sega Genesis',   color: '#1A1A2E', neon: '#bf00ff', desc: 'Sega Mega Drive / Genesis (1988) — Sega\'s powerhouse 16-bit console. Runs via EmulatorJS (Genesis Plus GX core).' },
  { id: 'nds',    name: 'Nintendo DS',    color: '#D4A017', neon: '#ff6a00', desc: 'Nintendo DS (2004) — Nintendo\'s dual-screen handheld with touch support. Runs via EmulatorJS (melonDS core).' },
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
        <button class="emu-system-card" data-system="${s.id}" data-s-card-neon="${s.neon}">
          <div class="emu-system-icon" data-s-bg="${s.color}">
            ${s.logo
              ? `<img src="${esc(s.logo)}" alt="${esc(s.name)}" class="emu-icon-img">`
              : `<svg viewBox="0 0 24 24" fill="none" width="36" height="36">
                  <rect x="2" y="6" width="20" height="14" rx="3" stroke="white" stroke-width="1.5"/>
                  <path d="M8 13h2m-1-1v2M15 13h.01M17 13h.01" stroke="white" stroke-width="2" stroke-linecap="round"/>
                </svg>`
            }
          </div>
          <div class="emu-system-name">${esc(s.name)}</div>
          <div class="emu-system-count" id="emu-count-${s.id}">—</div>
        </button>`
      ).join('')
    }</div>`;
    applyDataStyles(content);

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
      <div class="emu-system-hero" data-s-sys-neon="${sys?.neon || '#00d8ff'}">
        <button class="btn btn-ghost btn-sm emu-back-btn" id="emu-back">← Back</button>
        <h2 class="emu-system-hero-title">${esc(sys?.name || activeEmuSystem)}</h2>
        <p class="emu-system-hero-desc">${esc(sys?.desc || '')}</p>
        <div class="emu-system-hero-meta">${emuRoms.length} ROM${emuRoms.length !== 1 ? 's' : ''} available</div>
      </div>
      <div id="emu-rom-list">${
        !emuRoms.length
          ? `<div class="empty-state"><strong>No ROMs yet.</strong>${isAdmin ? '<p>Upload a ROM file to get started.</p>' : ''}</div>`
          : emuRoms.map(rom => `
              <div class="emu-rom-item" data-rom-id="${esc(rom.id)}">
                <div class="emu-rom-icon">
                  <svg viewBox="0 0 20 20" fill="none" width="18" height="18"><rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M7 8h6M7 11h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                </div>
                <div class="emu-rom-info">
                  <div class="emu-rom-name">${esc(rom.name)}</div>
                  <div class="emu-rom-meta">${formatFileSize(rom.size)}</div>
                </div>
                <div class="emu-rom-actions">
                  <button class="btn btn-accent btn-sm emu-play-btn" data-id="${esc(rom.id)}" data-name="${esc(rom.name)}">▶ Play</button>
                </div>
              </div>`
          ).join('')
      }</div>`;
    applyDataStyles(content);

    $id('emu-back').addEventListener('click', () => { activeEmuSystem = null; renderEmulators(); });

    content.querySelectorAll('.emu-play-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); launchEmulator(btn.dataset.id, btn.dataset.name); });
    });

    content.querySelectorAll('.emu-rom-item').forEach(item => {
      item.addEventListener('click', () => {
        const romId = item.dataset.romId;
        const linked = games.find(g => g.rom_id === romId);
        if (linked) openDetailModal(linked.id);
      });
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
  const romUrl = window.location.origin + `/api/roms/${romId}/file`;
  const url = `/emulator.html?core=${encodeURIComponent(activeEmuSystem)}&rom=${encodeURIComponent(romUrl)}`;
  window.open(url, '_blank');
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
      <div class="server-tile-bg"${s.image ? ` data-s-bg-img="${esc(s.image)}"` : ''}></div>
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
          <button class="server-tile-cfg-btn${s.config_path ? '' : ' hidden'}" data-id="${esc(s.id)}">⚙ Settings</button>
          ` : ''}
        </div>
      </div>
      ${isAdmin && s.config_path ? `<div class="server-tile-cfg hidden" data-cfg-id="${esc(s.id)}"><div class="server-cfg-loading">Loading settings…</div></div>` : ''}
    </div>
  `).join('');
  applyDataStyles(grid);

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
    <div class="admin-lookup-item col-start">
      <div class="flex-row-full">
        <strong>${esc(s.name)}</strong>
        <span class="muted-xs">${esc(s.host)}:${s.port}</span>
        <span class="ml-auto ${s.online ? 'server-online' : 'server-offline'}">${s.online ? '● Online' : '○ Offline'}</span>
        <button class="admin-lookup-delete" data-id="${esc(s.id)}" title="Delete">×</button>
      </div>
      ${s.description ? `<div class="admin-server-meta">${esc(s.description)}</div>` : ''}
      <div class="admin-server-meta">Start: <code>${esc(s.start_command || '—')}</code> &nbsp; Stop: <code>${esc(s.stop_command || '—')}</code></div>
      ${s.config_path ? `<div class="admin-server-meta">Config: <code>${esc(s.config_path)}</code></div>` : ''}
      ${s.image ? `<div class="admin-server-meta">Image: <code>${esc(s.image)}</code></div>` : ''}
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

// ── Controller Config ─────────────────────────────────────────────────────────

// DualSense button index → SVG element ID + display label
const DS_BUTTONS = [
  { id: 'ds-cross',    label: '✕',    color: '#7fa7e0' }, // 0
  { id: 'ds-circle',   label: '○',    color: '#f0566c' }, // 1
  { id: 'ds-square',   label: '□',    color: '#e8a0c8' }, // 2
  { id: 'ds-triangle', label: '△',    color: '#5ce5a0' }, // 3
  { id: 'ds-l1',       label: 'L1',   color: null },      // 4
  { id: 'ds-r1',       label: 'R1',   color: null },      // 5
  { id: 'ds-l2',       label: 'L2',   color: null },      // 6
  { id: 'ds-r2',       label: 'R2',   color: null },      // 7
  { id: 'ds-create',   label: 'Cre',  color: null },      // 8
  { id: 'ds-options',  label: 'Opt',  color: null },      // 9
  { id: 'ds-lstick',   label: 'L3',   color: null },      // 10
  { id: 'ds-rstick',   label: 'R3',   color: null },      // 11
  { id: 'ds-up',       label: '↑',    color: null },      // 12
  { id: 'ds-down',     label: '↓',    color: null },      // 13
  { id: 'ds-left',     label: '←',    color: null },      // 14
  { id: 'ds-right',    label: '→',    color: null },      // 15
  { id: 'ds-ps',       label: 'PS',   color: null },      // 16
  { id: 'ds-touchpad', label: 'TP',   color: null },      // 17
];

// Default gamepad button index → game action per system (DualSense standard mapping)
const DS_SYSTEM_MAP = {
  nes:    { 0:'B', 1:'A', 8:'Select', 9:'Start', 12:'↑', 13:'↓', 14:'←', 15:'→' },
  snes:   { 0:'B', 1:'A', 2:'Y', 3:'X', 4:'L', 5:'R', 8:'Select', 9:'Start', 12:'↑', 13:'↓', 14:'←', 15:'→' },
  n64:    { 0:'B', 1:'A', 4:'L', 5:'R', 6:'Z', 9:'Start', 12:'↑', 13:'↓', 14:'←', 15:'→' },
  gba:    { 0:'B', 1:'A', 4:'L', 5:'R', 8:'Select', 9:'Start', 12:'↑', 13:'↓', 14:'←', 15:'→' },
  psx:    { 0:'✕', 1:'○', 2:'□', 3:'△', 4:'L1', 5:'R1', 6:'L2', 7:'R2', 8:'Select', 9:'Start', 12:'↑', 13:'↓', 14:'←', 15:'→' },
  segaMD: { 0:'B', 1:'C', 2:'A', 9:'Start', 12:'↑', 13:'↓', 14:'←', 15:'→' },
  nds:    { 0:'B', 1:'A', 2:'Y', 3:'X', 4:'L', 5:'R', 8:'Select', 9:'Start', 12:'↑', 13:'↓', 14:'←', 15:'→' },
};

let activeCtrlSystem = null;
let gpPollId = null;

function keyLabel(k) {
  if (!k) return '?';
  if (k.startsWith('GP:')) {
    const i = parseInt(k.slice(3));
    return DS_BUTTONS[i]?.label ?? `B${i}`;
  }
  const m = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Enter: 'Ent', Escape: 'Esc', Backspace: 'Bksp',
    ' ': 'Spc', Space: 'Spc', Shift: 'Shft', Control: 'Ctrl', Alt: 'Alt', Tab: 'Tab',
  };
  if (m[k]) return m[k];
  if (k.startsWith('F') && k.length <= 3) return k;
  if (k.length === 1) return k.toUpperCase();
  return k.slice(0, 4);
}

function loadCtrlConfig() {
  try { return JSON.parse(localStorage.getItem('ctrl_config') || '{}'); } catch { return {}; }
}
function saveCtrlConfig(cfg) { localStorage.setItem('ctrl_config', JSON.stringify(cfg)); }
function resetBindings(systemId) {
  const cfg = loadCtrlConfig(); delete cfg[systemId]; saveCtrlConfig(cfg);
}

async function captureInput(neon, btnLabel) {
  return new Promise(resolve => {
    stopGamepadPoll();
    const overlay = document.createElement('div');
    overlay.className = 'ctrl-capture-overlay';
    overlay.innerHTML = `
      <div class="ctrl-capture-box" data-s-border="${neon}" data-s-color="${neon}">
        <div class="ctrl-capture-label">${esc(btnLabel)}</div>
        <div class="ctrl-capture-hint">Press any key or controller button…</div>
        <button class="btn btn-sm ctrl-capture-cancel">Cancel</button>
      </div>`;
    document.body.appendChild(overlay);
    applyDataStyles(overlay);

    let done = false;
    const finish = result => {
      if (done) return; done = true;
      clearInterval(gpPoll);
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      startGamepadPoll();
      resolve(result);
    };

    overlay.querySelector('.ctrl-capture-cancel').onclick = () => finish(null);

    const onKey = e => {
      if (e.key === 'Tab') return;
      e.preventDefault(); e.stopPropagation();
      finish(e.key);
    };
    window.addEventListener('keydown', onKey, true);

    const gpPoll = setInterval(() => {
      const gps = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gp of gps) {
        if (!gp) continue;
        for (let i = 0; i < gp.buttons.length; i++) {
          if (gp.buttons[i].pressed) { finish(`GP:${i}`); return; }
        }
      }
    }, 50);
  });
}

function buildDualSenseSVG(systemId) {
  const neon = EMULATOR_SYSTEMS.find(s => s.id === systemId)?.neon || '#00d8ff';
  const cfg   = loadCtrlConfig()[systemId] || {};
  const sysMap = DS_SYSTEM_MAP[systemId] || {};

  // Build per-button SVG element
  function btn(id, shape, cx, cy, label, btnColor, action) {
    const fill   = btnColor ? `${btnColor}30` : `${neon}1a`;
    const stroke = btnColor || neon;
    const shapeEl = shape === 'circle'
      ? `<circle id="${id}" class="ds-btn" cx="${cx}" cy="${cy}" r="${shape === 'circle' ? arguments[6+1] || 12 : 12}" fill="${fill}" stroke="${stroke}" stroke-width="1.3"/>`
      : shape; // raw svg string
    return shapeEl;
  }

  // Each interactive button group
  function mkBtn(id, shapeStr, cx, cy, dsLabel, btnColor, actionLabel) {
    const fill   = btnColor ? `${btnColor}30` : `${neon}1a`;
    const stroke = btnColor || neon;
    const mapping = cfg[id]; // custom remap stored by ds-id
    const mapDisplay = mapping ? keyLabel(mapping) : '';
    return `<g class="ds-btn-g" data-id="${id}" data-label="${esc(dsLabel)}" cursor="pointer">
      ${shapeStr.replace('FILL', fill).replace('STROKE', stroke)}
      <text text-anchor="middle" dominant-baseline="middle" font-family="monospace,sans-serif" pointer-events="none"
        x="${cx}" y="${cy - (actionLabel ? 3 : 0)}" fill="${btnColor || neon}" font-size="6" font-weight="700">${esc(dsLabel)}</text>
      ${actionLabel ? `<text text-anchor="middle" dominant-baseline="middle" font-family="monospace,sans-serif" pointer-events="none"
        x="${cx}" y="${cy + 5}" fill="rgba(255,255,255,0.5)" font-size="4.5">${esc(actionLabel)}</text>` : ''}
    </g>`;
  }

  function mkRect(id, x, y, w, h, rx, dsLabel, btnColor, action) {
    const shape = `<rect id="${id}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="FILL" stroke="STROKE" stroke-width="1.3"/>`;
    return mkBtn(id, shape, x + w/2, y + h/2, dsLabel, btnColor, action);
  }
  function mkCircle(id, cx, cy, r, dsLabel, btnColor, action) {
    const shape = `<circle id="${id}" cx="${cx}" cy="${cy}" r="${r}" fill="FILL" stroke="STROKE" stroke-width="1.3"/>`;
    return mkBtn(id, shape, cx, cy, dsLabel, btnColor, action);
  }

  return `<svg viewBox="0 0 560 310" xmlns="http://www.w3.org/2000/svg" id="ctrl-svg" class="ctrl-svg">
    <defs>
      <filter id="ds-glow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="4" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="ds-btn-glow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>

    <!-- Controller body -->
    <path d="M 158 22 Q 118 16 88 36 Q 58 54 48 88 Q 38 124 44 168
             Q 52 214 76 252 Q 100 287 144 292 Q 184 297 200 276
             Q 214 258 216 236 L 344 236
             Q 346 258 360 276 Q 376 297 416 292
             Q 460 287 484 252 Q 508 214 516 168
             Q 522 128 512 88 Q 502 54 472 36
             Q 442 16 402 22 Q 378 6 280 3 Q 182 6 158 22 Z"
          fill="#0d0d0d" stroke="${neon}" stroke-width="1.5" opacity="0.95" filter="url(#ds-glow)"/>

    <!-- Touchpad -->
    <g class="ds-btn-g" data-id="ds-touchpad" data-label="TP" cursor="pointer">
      <rect id="ds-touchpad" x="208" y="70" width="144" height="82" rx="10"
            fill="${neon}12" stroke="${neon}55" stroke-width="1.2"/>
      <text x="280" y="111" text-anchor="middle" dominant-baseline="middle"
            fill="${neon}66" font-size="8" font-family="monospace,sans-serif" pointer-events="none">TOUCHPAD</text>
      ${sysMap[17] ? `<text x="280" y="124" text-anchor="middle" dominant-baseline="middle" fill="rgba(255,255,255,0.35)" font-size="6" font-family="monospace,sans-serif" pointer-events="none">${esc(sysMap[17])}</text>` : ''}
    </g>

    <!-- L2 trigger -->
    ${mkRect('ds-l2', 34, 10, 90, 46, 14, 'L2', null, sysMap[6])}
    <!-- R2 trigger -->
    ${mkRect('ds-r2', 436, 10, 90, 46, 14, 'R2', null, sysMap[7])}
    <!-- L1 shoulder -->
    ${mkRect('ds-l1', 40, 62, 84, 18, 6, 'L1', null, sysMap[4])}
    <!-- R1 shoulder -->
    ${mkRect('ds-r1', 436, 62, 84, 18, 6, 'R1', null, sysMap[5])}

    <!-- D-pad cross background -->
    <rect x="104" y="84" width="14" height="46" rx="3" fill="${neon}08" stroke="${neon}22" stroke-width="1" pointer-events="none"/>
    <rect x="80" y="100" width="62" height="14" rx="3" fill="${neon}08" stroke="${neon}22" stroke-width="1" pointer-events="none"/>
    <!-- D-pad buttons — accurate DualSense layout, center (111,107) -->
    ${mkRect('ds-up',    104, 84,  14, 16, 3, '↑', null, sysMap[12])}
    ${mkRect('ds-down',  104, 114, 14, 16, 3, '↓', null, sysMap[13])}
    ${mkRect('ds-left',  80,  100, 16, 14, 3, '←', null, sysMap[14])}
    ${mkRect('ds-right', 126, 100, 16, 14, 3, '→', null, sysMap[15])}

    <!-- Face buttons — accurate PS5 diamond (ref: ps5-switch.svg viewport coords scaled 0.778) -->
    ${mkCircle('ds-triangle', 448,  62, 18, '△', '#5ce5a0', sysMap[3])}
    ${mkCircle('ds-circle',   488, 102, 18, '○', '#f0566c', sysMap[1])}
    ${mkCircle('ds-cross',    448, 141, 18, '✕', '#7fa7e0', sysMap[0])}
    ${mkCircle('ds-square',   408, 102, 18, '□', '#e8a0c8', sysMap[2])}

    <!-- Left stick — accurate position, outer r=37 -->
    <circle id="ds-lstick" class="ds-btn-g" data-id="ds-lstick" data-label="L3"
            cx="193" cy="196" r="37" fill="${neon}10" stroke="${neon}55" stroke-width="1.3" cursor="pointer"/>
    <circle id="ds-lstick-dot" cx="193" cy="196" r="14"
            fill="${neon}20" stroke="${neon}88" stroke-width="1" pointer-events="none"/>
    <text x="193" y="196" text-anchor="middle" dominant-baseline="middle"
          fill="${neon}88" font-size="7" font-family="monospace,sans-serif" pointer-events="none">L3</text>

    <!-- Right stick — accurate position -->
    <circle id="ds-rstick" class="ds-btn-g" data-id="ds-rstick" data-label="R3"
            cx="367" cy="196" r="37" fill="${neon}10" stroke="${neon}55" stroke-width="1.3" cursor="pointer"/>
    <circle id="ds-rstick-dot" cx="367" cy="196" r="14"
            fill="${neon}20" stroke="${neon}88" stroke-width="1" pointer-events="none"/>
    <text x="367" y="196" text-anchor="middle" dominant-baseline="middle"
          fill="${neon}88" font-size="7" font-family="monospace,sans-serif" pointer-events="none">R3</text>

    <!-- Create / Options -->
    ${mkCircle('ds-create',  230, 160, 10, 'Cre', null, sysMap[8])}
    ${mkCircle('ds-options', 330, 160, 10, 'Opt', null, sysMap[9])}

    <!-- PS button -->
    ${mkCircle('ds-ps', 280, 250, 15, 'PS', null, sysMap[16])}
  </svg>`;
}

function startGamepadPoll() {
  if (gpPollId) return;
  const STICK_MAX = 20; // max pixel offset for stick dot indicator
  function poll() {
    gpPollId = requestAnimationFrame(poll);
    const svg = $id('ctrl-svg');
    if (!svg) { stopGamepadPoll(); return; }

    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    let anyGp = false;
    for (const gp of gps) { if (gp) { anyGp = true; break; } }

    const status = $id('ctrl-gp-status');
    if (status) {
      status.textContent = anyGp ? '● Controller connected' : '○ No controller detected';
      status.style.color = anyGp ? '#00ff18' : 'rgba(255,255,255,0.3)';
    }

    // Clear all active states
    svg.querySelectorAll('.ds-active').forEach(el => {
      el.classList.remove('ds-active');
      el.style.filter = '';
    });

    if (!anyGp) return;
    const gp = [...gps].find(g => g);
    if (!gp) return;

    // Highlight pressed buttons
    gp.buttons.forEach((b, i) => {
      if (!b.pressed && b.value < 0.1) return;
      const def = DS_BUTTONS[i];
      if (!def) return;
      const el = $id(def.id);
      if (!el) return;
      el.classList.add('ds-active');
      const col = def.color || EMULATOR_SYSTEMS.find(s => s.id === activeCtrlSystem)?.neon || '#00d8ff';
      el.style.fill   = col + 'aa';
      el.style.filter = `drop-shadow(0 0 6px ${col})`;
    });

    // Move stick dots with axes
    const lx = gp.axes[0] || 0, ly = gp.axes[1] || 0;
    const rx = gp.axes[2] || 0, ry = gp.axes[3] || 0;
    const ldot = $id('ds-lstick-dot');
    const rdot = $id('ds-rstick-dot');
    if (ldot) { ldot.setAttribute('cx', 193 + lx * STICK_MAX); ldot.setAttribute('cy', 196 + ly * STICK_MAX); }
    if (rdot) { rdot.setAttribute('cx', 367 + rx * STICK_MAX); rdot.setAttribute('cy', 196 + ry * STICK_MAX); }
  }
  gpPollId = requestAnimationFrame(poll);
}

function stopGamepadPoll() {
  if (gpPollId) { cancelAnimationFrame(gpPollId); gpPollId = null; }
}

function renderControls() {
  if (!activeCtrlSystem) activeCtrlSystem = EMULATOR_SYSTEMS[0].id;
  const sys  = EMULATOR_SYSTEMS.find(s => s.id === activeCtrlSystem);
  const neon = sys?.neon || '#00d8ff';
  const content = $id('controls-content');

  const tabs = EMULATOR_SYSTEMS.map(s =>
    `<button class="ctrl-tab${s.id === activeCtrlSystem ? ' ctrl-tab--active' : ''}" data-sys="${s.id}" data-s-ct="${s.neon}">${esc(s.name)}</button>`
  ).join('');

  content.innerHTML = `
    <div class="ctrl-tabs">${tabs}</div>
    <div class="ctrl-diagram">${buildDualSenseSVG(activeCtrlSystem)}</div>
    <div class="ctrl-hint ctrl-hint-row">
      <span id="ctrl-gp-status" class="ctrl-gp-status-text">○ No controller detected</span>
      <span class="muted-sm">Click a button to remap</span>
    </div>
    <div class="ctrl-actions">
      <button class="btn btn-danger btn-sm" id="ctrl-reset">Reset ${esc(sys?.name || activeCtrlSystem)} to Defaults</button>
    </div>`;
  applyDataStyles(content);

  content.querySelectorAll('.ctrl-tab').forEach(tab => {
    tab.addEventListener('click', () => { activeCtrlSystem = tab.dataset.sys; stopGamepadPoll(); renderControls(); });
  });

  // Click any ds-btn-g to remap
  content.querySelectorAll('.ds-btn-g').forEach(el => {
    el.addEventListener('click', async () => {
      const btnId = el.dataset.id || el.id;
      const label = el.dataset.label || btnId;
      const input = await captureInput(neon, label);
      if (input) {
        const cfg = loadCtrlConfig();
        if (!cfg[activeCtrlSystem]) cfg[activeCtrlSystem] = {};
        cfg[activeCtrlSystem][btnId] = input;
        saveCtrlConfig(cfg);
        renderControls();
      }
    });
  });

  $id('ctrl-reset').addEventListener('click', () => {
    if (confirm(`Reset ${sys?.name || activeCtrlSystem} remaps to defaults?`)) {
      resetBindings(activeCtrlSystem);
      renderControls();
    }
  });

  startGamepadPoll();
}

// ── Neon letter random flicker ────────────────────────────────────────────────

(function flickerLoop() {
  const delay = 3000 + Math.random() * 7000;
  setTimeout(() => {
    const candidates = Array.from(document.querySelectorAll(
      '.view[data-view="library"] .view-title .neon-letter:not(.neon-letter--lit),' +
      '.view[data-view="search"] .view-title .neon-letter:not(.neon-letter--lit),' +
      '.view[data-view="hosted"] .view-title .neon-letter:not(.neon-letter--lit),' +
      '.view[data-view="controls"] .view-title .neon-letter:not(.neon-letter--lit)'
    ));
    if (candidates.length) {
      const el = candidates[Math.floor(Math.random() * candidates.length)];
      el.classList.add('neon-letter--flickering');
      el.addEventListener('animationend', () => el.classList.remove('neon-letter--flickering'), { once: true });
    }
    flickerLoop();
  }, delay);
})();

// ── Neon letter click-to-lock ──────────────────────────────────────────────────

document.querySelectorAll(
  '.view[data-view="library"] .view-title .neon-letter,' +
  '.view[data-view="search"] .view-title .neon-letter,' +
  '.view[data-view="hosted"] .view-title .neon-letter,' +
  '.view[data-view="controls"] .view-title .neon-letter'
).forEach(el => {
  el.addEventListener('click', () => el.classList.toggle('neon-letter--lit'));
});

// ── Boot ──────────────────────────────────────────────────────────────────────
init();

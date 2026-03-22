'use strict';

// Load .env if present
const fs_env = require('fs'), path_env = require('path');
const envPath = path_env.join(__dirname, '.env');
if (fs_env.existsSync(envPath)) {
  fs_env.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  });
}

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const multer   = require('multer');
const AdmZip   = require('adm-zip');
const net      = require('net');
const { exec } = require('child_process');
const {
  requireAuth, requireAdmin,
  safeUser, getUserCount, getUserById, getUserByUsername,
  createUser, createSession, getSession, touchSession, deleteSession,
} = require('@hub/auth');
const {
  listGames, getGameById, createGame, updateGame, deleteGame,
  getLibraryEntry, listLibrary, upsertLibraryEntry, removeLibraryEntry, getLibraryStats,
  listSessions, getSessionById, startSession, endSession, createManualSession,
  deleteSession: deletePlaytimeSession, getPlaytime, getOpenSession, getLastPlayedMap,
  listGenres, createGenre, deleteGenre,
  listPlatforms, createPlatform, deletePlatform,
  listRoms, getRomById, getGameByRomId, createRom, deleteRom,
  listHostedServers, getHostedServerById, createHostedServer, updateHostedServer, deleteHostedServer,
  listReviews, getReviewByUser, upsertReview, deleteReview,
} = require('./db');

const romsDir = path.join(__dirname, 'roms');
if (!fs.existsSync(romsDir)) fs.mkdirSync(romsDir);

const romUpload = multer({
  storage: multer.diskStorage({
    destination: romsDir,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}-${file.originalname}`),
  }),
  limits: { fileSize: 512 * 1024 * 1024 }, // 512 MB
});

const imagesDir = path.join(__dirname, 'public', 'img', 'games');
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: imagesDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Images only'));
  },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/api/auth/status', (req, res) => {
  const needsSetup = getUserCount() === 0;
  const token = req.headers['x-hub-session'];
  if (!token) return res.json({ needsSetup, loggedIn: false });
  const session = getSession(token);
  if (!session) return res.json({ needsSetup, loggedIn: false });
  const user = getUserById(session.userId);
  if (!user) return res.json({ needsSetup, loggedIn: false });
  touchSession(token);
  return res.json({ needsSetup, loggedIn: true, user: safeUser(user) });
});

app.post('/api/auth/setup', async (req, res) => {
  if (getUserCount() > 0) return res.status(400).json({ error: 'Setup already complete' });
  const { username, password, firstName, lastName } = req.body;
  if (!username || !password || !firstName || !lastName)
    return res.status(400).json({ error: 'All fields required' });
  try {
    const hash  = await bcrypt.hash(password, 10);
    const user  = createUser({ username, password: hash, firstName, lastName, role: 'admin' });
    const token = createSession(user.id);
    res.json({ token, user: safeUser(user) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = getUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid username or password' });
  const token = createSession(user.id);
  res.json({ token, user: safeUser(user) });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  deleteSession(req.sessionToken);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json(safeUser(req.user)));

// ── Games Catalog ─────────────────────────────────────────────────────────────

app.get('/api/games', requireAuth, (req, res) => {
  const { search, genre, platform, tag, sort } = req.query;
  const includeDisabled = req.user.role === 'admin' && req.query.includeDisabled === '1';
  const games = listGames({ search, genre, platform, tag, sort, includeDisabled });
  const lastPlayedMap = getLastPlayedMap(req.user.id);
  const result = games.map(g => {
    const entry = getLibraryEntry(req.user.id, g.id);
    return { ...g, libraryEntry: entry || null, last_played_at: lastPlayedMap[g.id] || null };
  });
  res.json(result);
});

app.get('/api/games/:id', requireAuth, (req, res) => {
  const game = getGameById(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (!game.reviewed && req.user.role !== 'admin') return res.status(404).json({ error: 'Game not found' });
  const entry = getLibraryEntry(req.user.id, game.id);
  res.json({ ...game, libraryEntry: entry || null });
});

app.post('/api/games', requireAuth, requireAdmin, (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  try {
    const game = createGame(req.body, req.user.id);
    res.status(201).json(game);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/games/:id', requireAuth, requireAdmin, (req, res) => {
  const game = updateGame(req.params.id, req.body);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json(game);
});

app.post('/api/images', requireAuth, requireAdmin, imageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  res.json({ url: `/img/games/${req.file.filename}` });
});

app.delete('/api/games/:id', requireAuth, requireAdmin, (req, res) => {
  const game = getGameById(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.rom_id) {
    const rom = getRomById(game.rom_id);
    if (rom) fs.unlink(path.join(romsDir, rom.filename), () => {});
    deleteRom(game.rom_id);
  }
  deleteGame(req.params.id);
  res.json({ ok: true });
});

// ── User Library ──────────────────────────────────────────────────────────────

app.get('/api/library', requireAuth, (req, res) => {
  const rows = listLibrary(req.user.id, req.query.status || '');
  res.json(rows);
});

app.get('/api/library/stats', requireAuth, (req, res) => {
  res.json(getLibraryStats(req.user.id));
});

app.post('/api/library', requireAuth, (req, res) => {
  const { game_id, status } = req.body;
  if (!game_id) return res.status(400).json({ error: 'game_id required' });
  if (!getGameById(game_id)) return res.status(404).json({ error: 'Game not found' });
  try {
    const entry = upsertLibraryEntry(req.user.id, game_id, { status: status || 'backlog' });
    res.status(201).json(entry);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/library/:game_id', requireAuth, (req, res) => {
  if (!getGameById(req.params.game_id)) return res.status(404).json({ error: 'Game not found' });
  try {
    const entry = upsertLibraryEntry(req.user.id, req.params.game_id, req.body);
    res.json(entry);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/library/:game_id', requireAuth, (req, res) => {
  removeLibraryEntry(req.user.id, req.params.game_id);
  res.json({ ok: true });
});

// ── Playtime Sessions ─────────────────────────────────────────────────────────

app.get('/api/games/:id/playtime', requireAuth, (req, res) => {
  res.json(getPlaytime(req.user.id, req.params.id));
});

app.post('/api/games/:id/sessions/start', requireAuth, (req, res) => {
  if (!getGameById(req.params.id)) return res.status(404).json({ error: 'Game not found' });
  // Close any lingering open session first
  const open = getOpenSession(req.user.id, req.params.id);
  if (open) endSession(open.id);
  try {
    const session = startSession(req.user.id, req.params.id, req.body.notes);
    const entry = getLibraryEntry(req.user.id, req.params.id);
    const updates = {};
    // Auto-set started_at on first ever session
    if (!entry?.started_at) updates.started_at = session.started_at;
    // Auto-set status to playing unless already completed
    if (!entry || ['backlog', 'wishlist', 'dropped'].includes(entry.status)) updates.status = 'playing';
    if (Object.keys(updates).length) upsertLibraryEntry(req.user.id, req.params.id, updates);
    res.status(201).json(session);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/games/:id/sessions/:sid/end', requireAuth, (req, res) => {
  const session = getSessionById(req.params.sid);
  if (!session || session.user_id !== req.user.id) return res.status(404).json({ error: 'Session not found' });
  res.json(endSession(req.params.sid, req.body.notes));
});

app.post('/api/games/:id/sessions', requireAuth, (req, res) => {
  if (!getGameById(req.params.id)) return res.status(404).json({ error: 'Game not found' });
  const { started_at, ended_at, duration_min } = req.body;
  if (!started_at || !ended_at || duration_min === undefined)
    return res.status(400).json({ error: 'started_at, ended_at, duration_min required' });
  try {
    const session = createManualSession(req.user.id, req.params.id, req.body);
    // Auto-set started_at on first ever session
    const entry = getLibraryEntry(req.user.id, req.params.id);
    if (entry && !entry.started_at) {
      upsertLibraryEntry(req.user.id, req.params.id, { started_at: session.started_at });
    }
    res.status(201).json(session);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/games/:id/sessions/:sid', requireAuth, (req, res) => {
  const session = getSessionById(req.params.sid);
  if (!session || session.user_id !== req.user.id) return res.status(404).json({ error: 'Session not found' });
  deletePlaytimeSession(req.params.sid);
  res.json({ ok: true });
});

// ── Reviews ───────────────────────────────────────────────────────────────────

app.get('/api/games/:id/reviews', requireAuth, (req, res) => {
  res.json(listReviews(req.params.id));
});

app.put('/api/games/:id/reviews', requireAuth, (req, res) => {
  const { rating, body } = req.body;
  if (!rating || !body?.trim()) return res.status(400).json({ error: 'rating and body required' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'rating must be 1–5' });
  const review = upsertReview({
    gameId: req.params.id,
    userId: req.user.id,
    username: req.user.username,
    rating: parseInt(rating),
    body: body.trim(),
  });
  res.json(review);
});

app.delete('/api/games/:id/reviews', requireAuth, (req, res) => {
  const review = getReviewByUser(req.params.id, req.user.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  deleteReview(review.id);
  res.json({ ok: true });
});

// ── RAWG Lookup ───────────────────────────────────────────────────────────────

const RAWG_KEY = '4c0c771ed45649dbaa766c35a88bd940';

// ── IGDB Lookup ───────────────────────────────────────────────────────────────

const IGDB_CLIENT_ID     = process.env.IGDB_CLIENT_ID     || '';
const IGDB_CLIENT_SECRET = process.env.IGDB_CLIENT_SECRET || '';

let _igdbToken = null;
let _igdbTokenExpiry = 0;

async function getIgdbToken() {
  if (_igdbToken && Date.now() < _igdbTokenExpiry - 60_000) return _igdbToken;
  const r = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${IGDB_CLIENT_ID}&client_secret=${IGDB_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  if (!r.ok) throw new Error('IGDB auth failed');
  const d = await r.json();
  _igdbToken = d.access_token;
  _igdbTokenExpiry = Date.now() + d.expires_in * 1000;
  return _igdbToken;
}

async function igdbPost(endpoint, body) {
  const token = await getIgdbToken();
  const r = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: 'POST',
    headers: {
      'Client-ID': IGDB_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    body,
  });
  if (!r.ok) throw new Error(`IGDB ${endpoint} failed: ${r.status}`);
  return r.json();
}

app.get('/api/igdb/search', requireAuth, requireAdmin, async (req, res) => {
  if (!IGDB_CLIENT_ID) return res.status(503).json({ error: 'IGDB not configured' });
  const { q, platform } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const platformFilter = platform ? `& platforms = ${parseInt(platform)}` : '';
    let results = await igdbPost('games',
      `fields id,name,first_release_date,cover.url,platforms.name;
       search "${q.replace(/"/g, '')}";
       ${platformFilter ? `where ${platformFilter.slice(2)};` : ''}
       limit 12;`
    );
    // If platform filter returned nothing, retry without it
    if (!results.length && platformFilter) {
      results = await igdbPost('games',
        `fields id,name,first_release_date,cover.url,platforms.name;
         search "${q.replace(/"/g, '')}";
         limit 12;`
      );
    }
    res.json(results.map(g => ({
      id:       g.id,
      name:     g.name,
      year:     g.first_release_date ? new Date(g.first_release_date * 1000).getFullYear() : null,
      cover:    g.cover?.url?.replace('t_thumb', 't_cover_big') || null,
      platforms: (g.platforms || []).map(p => p.name),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/igdb/game/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!IGDB_CLIENT_ID) return res.status(503).json({ error: 'IGDB not configured' });
  try {
    const [game] = await igdbPost('games',
      `fields name, summary, first_release_date, cover.url, artworks.url, screenshots.url,
              genres.name, platforms.name,
              involved_companies.company.name, involved_companies.developer, involved_companies.publisher;
       where id = ${parseInt(req.params.id)};`
    );
    if (!game) return res.status(404).json({ error: 'Not found' });
    const dev = game.involved_companies?.find(c => c.developer)?.company?.name || '';
    const pub = game.involved_companies?.find(c => c.publisher)?.company?.name || '';
    const cover = game.cover?.url?.replace('t_thumb', 't_cover_big_2x') || '';
    const hero  = game.artworks?.[0]?.url?.replace('t_thumb', 't_1080p') || cover;
    const allImages = [
      ...(game.cover ? [{ url: `https:${cover}`, type: 'cover' }] : []),
      ...(game.artworks || []).map(a => ({ url: `https:${a.url.replace('t_thumb', 't_1080p')}`, type: 'artwork' })),
      ...(game.screenshots || []).map(s => ({ url: `https:${s.url.replace('t_thumb', 't_screenshot_big')}`, type: 'screenshot' })),
    ];
    res.json({
      title:        game.name,
      description:  game.summary || '',
      cover_url:    cover ? `https:${cover}` : '',
      hero_url:     hero  ? `https:${hero}`  : '',
      release_year: game.first_release_date ? new Date(game.first_release_date * 1000).getFullYear() : null,
      developer:    dev,
      publisher:    pub,
      genres:       (game.genres || []).map(g => g.name),
      platforms:    (game.platforms || []).map(p => p.name),
      all_images:   allImages,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/rawg/search', requireAuth, requireAdmin, async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q required' });
  const r = await fetch(`https://api.rawg.io/api/games?key=${RAWG_KEY}&search=${encodeURIComponent(q)}&page_size=6`);
  const data = await r.json();
  res.json((data.results || []).map(g => ({
    id: g.id, name: g.name,
    cover: g.background_image,
    year: g.released ? parseInt(g.released) : null,
    metacritic: g.metacritic,
    slug: g.slug,
  })));
});

app.get('/api/rawg/game/:slug', requireAuth, requireAdmin, async (req, res) => {
  const [r, sr] = await Promise.all([
    fetch(`https://api.rawg.io/api/games/${req.params.slug}?key=${RAWG_KEY}`),
    fetch(`https://api.rawg.io/api/games/${req.params.slug}/screenshots?key=${RAWG_KEY}`),
  ]);
  const [g, ss] = await Promise.all([r.json(), sr.json()]);
  const allImages = [
    ...(g.background_image ? [{ url: g.background_image, type: 'cover' }] : []),
    ...(ss.results || []).map(s => ({ url: s.image, type: 'screenshot' })),
  ];
  res.json({
    title:       g.name,
    description: g.description_raw || '',
    cover_url:   g.background_image || '',
    release_year: g.released ? parseInt(g.released) : null,
    developer:   g.developers?.[0]?.name || '',
    publisher:   g.publishers?.[0]?.name || '',
    genres:      (g.genres || []).map(x => x.name),
    platforms:   (g.platforms || []).map(x => x.platform.name),
    metacritic:  g.metacritic || null,
    rating_esrb: g.esrb_rating?.name || null,
    all_images:  allImages,
  });
});

// ── Genres ────────────────────────────────────────────────────────────────────

app.get('/api/genres', requireAuth, (req, res) => res.json(listGenres()));

app.post('/api/genres', requireAuth, requireAdmin, (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Name required' });
  try { res.status(201).json(createGenre(req.body.name)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/genres/:id', requireAuth, requireAdmin, (req, res) => {
  deleteGenre(req.params.id); res.json({ ok: true });
});

// ── Platforms ─────────────────────────────────────────────────────────────────

app.get('/api/platforms', requireAuth, (req, res) => res.json(listPlatforms()));

app.post('/api/platforms', requireAuth, requireAdmin, (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Name required' });
  try { res.status(201).json(createPlatform(req.body.name)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/platforms/:id', requireAuth, requireAdmin, (req, res) => {
  deletePlatform(req.params.id); res.json({ ok: true });
});

// ── ROMs ──────────────────────────────────────────────────────────────────────

app.get('/api/roms', requireAuth, (req, res) => {
  res.json(listRoms(req.query.system || ''));
});

app.post('/api/roms', requireAuth, requireAdmin, romUpload.single('rom'), (req, res) => {
  const { system, name } = req.body;
  if (!system || !name || !req.file)
    return res.status(400).json({ error: 'system, name, and rom file are required' });

  let filename = req.file.filename;
  let size     = req.file.size;

  try {
    if (req.file.originalname.toLowerCase().endsWith('.zip')) {
      const zip     = new AdmZip(path.join(romsDir, filename));
      const entries = zip.getEntries().filter(e => !e.isDirectory && !e.entryName.startsWith('__MACOSX'));
      if (!entries.length) {
        fs.unlink(path.join(romsDir, filename), () => {});
        return res.status(400).json({ error: 'ZIP contains no files' });
      }
      const entry   = entries[0];
      const ext     = path.extname(entry.entryName);
      const outName = `${crypto.randomUUID()}${ext}`;
      zip.extractEntryTo(entry, romsDir, false, true, false, outName);
      fs.unlink(path.join(romsDir, filename), () => {});
      filename = outName;
      size     = entry.header.size;
    }

    const rom = createRom({ system, name, filename, size });
    res.status(201).json(rom);
  } catch (err) {
    fs.unlink(path.join(romsDir, filename), () => {});
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/roms/:id', requireAuth, (req, res) => {
  const rom = getRomById(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });
  res.json(rom);
});

app.get('/api/roms/:id/file', (req, res) => {
  const rom = getRomById(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });
  const filePath = path.join(romsDir, rom.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'ROM file missing' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(filePath);
});

app.delete('/api/roms/:id', requireAuth, requireAdmin, (req, res) => {
  const rom = getRomById(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });
  fs.unlink(path.join(romsDir, rom.filename), () => {});
  const linkedGame = getGameByRomId(req.params.id);
  if (linkedGame) deleteGame(linkedGame.id);
  deleteRom(req.params.id);
  res.json({ ok: true });
});

// ── Hosted Servers ─────────────────────────────────────────────────────────────

function checkServerReady(service) {
  if (!service) return Promise.resolve(false);
  return new Promise(resolve => {
    exec(
      `START=$(systemctl show ${service} --property=ActiveEnterTimestamp --value 2>/dev/null); journalctl -u ${service} --since "$START" --no-pager -o cat 2>/dev/null | grep -q "Done.*For help" && echo active || echo inactive`,
      (err, stdout) => resolve((stdout || '').trim() === 'active')
    );
  });
}

const startingServers = new Set();

function checkServiceActive(service) {
  if (!service) return Promise.resolve(false);
  return new Promise(resolve => {
    exec(`systemctl is-active ${service}`, (err, stdout) => {
      const s = (stdout || '').trim();
      resolve(s === 'active' || s === 'activating');
    });
  });
}

app.get('/api/hosted', requireAuth, async (req, res) => {
  const servers = listHostedServers();
  const result = await Promise.all(servers.map(async s => {
    const online = await checkServerReady(s.rcon_service);
    if (online) { startingServers.delete(s.id); return { ...s, online, starting: false }; }
    const starting = startingServers.has(s.id) || await checkServiceActive(s.rcon_service);
    return { ...s, online, starting };
  }));
  res.json(result);
});

app.post('/api/hosted', requireAuth, requireAdmin, (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Name required' });
  try { res.status(201).json(createHostedServer(req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/hosted/:id', requireAuth, requireAdmin, (req, res) => {
  const s = updateHostedServer(req.params.id, req.body);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  res.json(s);
});

app.delete('/api/hosted/:id', requireAuth, requireAdmin, (req, res) => {
  if (!getHostedServerById(req.params.id)) return res.status(404).json({ error: 'Server not found' });
  deleteHostedServer(req.params.id);
  res.json({ ok: true });
});

app.post('/api/hosted/:id/start', requireAuth, requireAdmin, (req, res) => {
  const s = getHostedServerById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!s.start_command) return res.status(400).json({ error: 'No start command configured' });
  startingServers.add(s.id);
  exec(s.start_command, () => {});
  res.json({ ok: true });
});

app.post('/api/hosted/:id/stop', requireAuth, requireAdmin, (req, res) => {
  const s = getHostedServerById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!s.stop_command) return res.status(400).json({ error: 'No stop command configured' });
  exec(s.stop_command, () => {});
  res.json({ ok: true });
});

app.get('/api/hosted/:id/config', requireAuth, requireAdmin, (req, res) => {
  const s = getHostedServerById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!s.config_path) return res.json({});
  try {
    const raw = fs.readFileSync(s.config_path, 'utf8');
    const cfg = {};
    for (const line of raw.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      cfg[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    res.json(cfg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/hosted/:id/config', requireAuth, requireAdmin, (req, res) => {
  const s = getHostedServerById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!s.config_path) return res.status(400).json({ error: 'No config path set' });
  try {
    let raw = fs.readFileSync(s.config_path, 'utf8');
    for (const [key, val] of Object.entries(req.body)) {
      const re = new RegExp(`^(${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=).*$`, 'm');
      raw = re.test(raw) ? raw.replace(re, `$1${val}`) : raw + `\n${key}=${val}`;
    }
    fs.writeFileSync(s.config_path, raw);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Hosted server console (SSE log stream + RCON commands) ───────────────────

app.get('/api/hosted/:id/console', requireAuth, requireAdmin, (req, res) => {
  const s = getHostedServerById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const service = s.rcon_service || '';
  if (!service) return res.status(400).json({ error: 'No log service configured' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const proc = require('child_process').spawn('journalctl', ['-u', service, '-f', '--no-pager', '-o', 'cat', '-n', '80']);
  proc.stdout.on('data', chunk => {
    chunk.toString().split('\n').filter(l => l).forEach(line => send({ line }));
  });
  proc.stderr.on('data', chunk => {
    chunk.toString().split('\n').filter(l => l).forEach(line => send({ line, err: true }));
  });

  req.on('close', () => proc.kill());
});

app.post('/api/hosted/:id/console/cmd', requireAuth, requireAdmin, async (req, res) => {
  const s = getHostedServerById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!s.rcon_password || !s.rcon_port) return res.status(400).json({ error: 'RCON not configured' });

  const { command } = req.body;
  if (!command || typeof command !== 'string') return res.status(400).json({ error: 'command required' });

  let Rcon;
  try { Rcon = require('rcon-client').Rcon; } catch { return res.status(500).json({ error: 'rcon-client not installed' }); }

  const rcon = new Rcon({ host: s.host || '127.0.0.1', port: s.rcon_port, password: s.rcon_password });
  try {
    await rcon.connect();
    const response = await rcon.send(command.trim());
    await rcon.end();
    res.json({ ok: true, response });
  } catch (err) {
    try { await rcon.end(); } catch {}
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-shutdown ─────────────────────────────────────────────────────────────

const emptySince = new Map(); // server id → timestamp when it became empty

async function getRconPlayerCount(s) {
  let Rcon;
  try { Rcon = require('rcon-client').Rcon; } catch { return null; }
  const rcon = new Rcon({ host: s.host || '127.0.0.1', port: s.rcon_port, password: s.rcon_password });
  try {
    await rcon.connect();
    const response = await rcon.send('list');
    await rcon.end();
    const match = response.match(/There are (\d+)/);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    try { await rcon.end(); } catch {}
    return null;
  }
}

async function autoShutdownTick() {
  const servers = listHostedServers().filter(s => s.auto_shutdown_hours && s.rcon_password && s.stop_command);
  for (const s of servers) {
    try {
      const ready = await checkServerReady(s.rcon_service);
      if (!ready) { emptySince.delete(s.id); continue; }

      const count = await getRconPlayerCount(s);
      if (count === null) continue; // RCON unavailable, skip

      if (count > 0) {
        emptySince.delete(s.id);
      } else {
        if (!emptySince.has(s.id)) emptySince.set(s.id, Date.now());
        const emptyMs = Date.now() - emptySince.get(s.id);
        if (emptyMs >= s.auto_shutdown_hours * 60 * 60 * 1000) {
          console.log(`[auto-shutdown] ${s.name} empty for ${s.auto_shutdown_hours}h — stopping`);
          emptySince.delete(s.id);
          exec(s.stop_command, () => {});
        }
      }
    } catch (err) {
      console.error(`[auto-shutdown] error for ${s.name}:`, err.message);
    }
  }
}

setInterval(autoShutdownTick, 5 * 60 * 1000); // check every 5 minutes

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3003;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Games\n`);
    console.log(`  http://localhost:${PORT}\n`);
  });
}

module.exports = app;

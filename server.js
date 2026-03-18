'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const multer   = require('multer');
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
  deleteSession: deletePlaytimeSession, getPlaytime, getOpenSession,
  listGenres, createGenre, deleteGenre,
  listPlatforms, createPlatform, deletePlatform,
  listRoms, getRomById, createRom, deleteRom,
  listHostedServers, getHostedServerById, createHostedServer, updateHostedServer, deleteHostedServer,
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
  const games = listGames({ search, genre, platform, tag, sort });
  // Merge each user's library entry into the game object
  const result = games.map(g => {
    const entry = getLibraryEntry(req.user.id, g.id);
    return { ...g, libraryEntry: entry || null };
  });
  res.json(result);
});

app.get('/api/games/:id', requireAuth, (req, res) => {
  const game = getGameById(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
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

app.delete('/api/games/:id', requireAuth, requireAdmin, (req, res) => {
  if (!getGameById(req.params.id)) return res.status(404).json({ error: 'Game not found' });
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
    const entry = upsertLibraryEntry(req.user.id, game_id, { status: status || 'wishlist' });
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
    res.status(201).json(session);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/games/:id/sessions/:sid', requireAuth, (req, res) => {
  const session = getSessionById(req.params.sid);
  if (!session || session.user_id !== req.user.id) return res.status(404).json({ error: 'Session not found' });
  deletePlaytimeSession(req.params.sid);
  res.json({ ok: true });
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
  try {
    const rom = createRom({ system, name, filename: req.file.filename, size: req.file.size });
    res.status(201).json(rom);
  } catch (err) {
    fs.unlink(path.join(romsDir, req.file.filename), () => {});
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/roms/:id/file', requireAuth, (req, res) => {
  const rom = getRomById(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });
  const filePath = path.join(romsDir, rom.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'ROM file missing' });
  res.download(filePath, rom.name + path.extname(rom.filename));
});

app.delete('/api/roms/:id', requireAuth, requireAdmin, (req, res) => {
  const rom = getRomById(req.params.id);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });
  fs.unlink(path.join(romsDir, rom.filename), () => {});
  deleteRom(req.params.id);
  res.json({ ok: true });
});

// ── Hosted Servers ─────────────────────────────────────────────────────────────

function checkServerPort(host, port) {
  return new Promise(resolve => {
    const s = net.createConnection(port, host);
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 3000);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.once('error',   () => { clearTimeout(t); s.destroy(); resolve(false); });
  });
}

app.get('/api/hosted', requireAuth, async (req, res) => {
  const servers = listHostedServers();
  const result = await Promise.all(servers.map(async s => ({
    ...s,
    online: await checkServerPort(s.host, s.port),
  })));
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

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3003;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Games\n`);
    console.log(`  http://localhost:${PORT}\n`);
  });
}

module.exports = app;

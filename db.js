'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const crypto   = require('crypto');

const db = new Database(
  process.env.NODE_ENV === 'test' ? ':memory:' : path.join(__dirname, 'games.db')
);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    cover_url    TEXT NOT NULL DEFAULT '',
    hero_url     TEXT NOT NULL DEFAULT '',
    release_year INTEGER,
    developer    TEXT NOT NULL DEFAULT '',
    publisher    TEXT NOT NULL DEFAULT '',
    genres       TEXT NOT NULL DEFAULT '[]',
    platforms    TEXT NOT NULL DEFAULT '[]',
    tags         TEXT NOT NULL DEFAULT '[]',
    rating_esrb  TEXT,
    metacritic   INTEGER,
    trailer_url  TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    created_by   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_library (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'wishlist',
    user_rating  INTEGER,
    notes        TEXT NOT NULL DEFAULT '',
    started_at   TEXT,
    completed_at TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE(user_id, game_id)
  );

  CREATE TABLE IF NOT EXISTS playtime_sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    duration_min INTEGER,
    notes        TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS genres (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS platforms (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE INDEX IF NOT EXISTS idx_ul_user   ON user_library(user_id);
  CREATE INDEX IF NOT EXISTS idx_ul_game   ON user_library(game_id);
  CREATE INDEX IF NOT EXISTS idx_ul_status ON user_library(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_ps_user   ON playtime_sessions(user_id, game_id);
`);

// Seed default genres and platforms if empty
const genreCount = db.prepare('SELECT COUNT(*) AS n FROM genres').get().n;
if (genreCount === 0) {
  const ins = db.prepare('INSERT OR IGNORE INTO genres (id, name) VALUES (?, ?)');
  [
    'Action', 'Adventure', 'RPG', 'Strategy', 'Simulation', 'Sports',
    'Racing', 'Puzzle', 'Horror', 'Platformer', 'Fighting', 'Shooter',
    'Stealth', 'Survival', 'Metroidvania', 'Roguelike', 'Visual Novel',
    'Rhythm', 'Open World', 'Sandbox'
  ].forEach(n => ins.run(crypto.randomUUID(), n));
}

const platCount = db.prepare('SELECT COUNT(*) AS n FROM platforms').get().n;
if (platCount === 0) {
  const ins = db.prepare('INSERT OR IGNORE INTO platforms (id, name) VALUES (?, ?)');
  [
    'PC', 'PlayStation 5', 'PlayStation 4', 'Xbox Series X/S',
    'Xbox One', 'Nintendo Switch', 'iOS', 'Android',
    'PlayStation 3', 'Xbox 360', 'Nintendo 3DS', 'PS Vita'
  ].forEach(n => ins.run(crypto.randomUUID(), n));
}

// ── Games ─────────────────────────────────────────────────────────────────────

function listGames({ search = '', genre = '', platform = '', tag = '', sort = 'title' } = {}) {
  let sql = 'SELECT * FROM games WHERE 1=1';
  const params = [];
  if (search) { sql += ' AND title LIKE ?'; params.push(`%${search}%`); }
  if (genre)  { sql += ` AND json_extract(genres, '$') LIKE ?`; params.push(`%"${genre}"%`); }
  if (platform) { sql += ` AND json_extract(platforms, '$') LIKE ?`; params.push(`%"${platform}"%`); }
  if (tag)    { sql += ` AND json_extract(tags, '$') LIKE ?`; params.push(`%"${tag}"%`); }
  const order = sort === 'year' ? 'release_year DESC NULLS LAST' :
                sort === 'metacritic' ? 'metacritic DESC NULLS LAST' :
                sort === 'newest' ? 'created_at DESC' : 'title ASC';
  sql += ` ORDER BY ${order}`;
  return db.prepare(sql).all(...params).map(parseGame);
}

function getGameById(id) {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
  return g ? parseGame(g) : null;
}

function createGame(data, userId) {
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO games (id, title, description, cover_url, hero_url, release_year,
      developer, publisher, genres, platforms, tags, rating_esrb, metacritic,
      trailer_url, created_at, updated_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, data.title, data.description || '', data.cover_url || '', data.hero_url || '',
    data.release_year || null, data.developer || '', data.publisher || '',
    JSON.stringify(data.genres || []), JSON.stringify(data.platforms || []),
    JSON.stringify(data.tags || []), data.rating_esrb || null,
    data.metacritic || null, data.trailer_url || null, now, now, userId
  );
  return getGameById(id);
}

function updateGame(id, data) {
  const existing = getGameById(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const fields = [];
  const params = [];
  const allowed = ['title','description','cover_url','hero_url','release_year',
    'developer','publisher','rating_esrb','metacritic','trailer_url'];
  for (const k of allowed) {
    if (data[k] !== undefined) { fields.push(`${k} = ?`); params.push(data[k] ?? null); }
  }
  for (const k of ['genres','platforms','tags']) {
    if (data[k] !== undefined) { fields.push(`${k} = ?`); params.push(JSON.stringify(data[k])); }
  }
  if (!fields.length) return existing;
  fields.push('updated_at = ?'); params.push(now);
  params.push(id);
  db.prepare(`UPDATE games SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getGameById(id);
}

function deleteGame(id) {
  db.prepare('DELETE FROM games WHERE id = ?').run(id);
}

function parseGame(row) {
  return {
    ...row,
    genres:    JSON.parse(row.genres    || '[]'),
    platforms: JSON.parse(row.platforms || '[]'),
    tags:      JSON.parse(row.tags      || '[]'),
  };
}

// ── User Library ──────────────────────────────────────────────────────────────

function getLibraryEntry(userId, gameId) {
  return db.prepare('SELECT * FROM user_library WHERE user_id = ? AND game_id = ?').get(userId, gameId) || null;
}

function listLibrary(userId, status = '') {
  let sql = 'SELECT ul.*, g.title, g.cover_url, g.hero_url, g.developer, g.genres, g.platforms, g.metacritic FROM user_library ul JOIN games g ON g.id = ul.game_id WHERE ul.user_id = ?';
  const params = [userId];
  if (status) { sql += ' AND ul.status = ?'; params.push(status); }
  sql += ' ORDER BY ul.updated_at DESC';
  return db.prepare(sql).all(...params);
}

function upsertLibraryEntry(userId, gameId, data) {
  const existing = getLibraryEntry(userId, gameId);
  const now = new Date().toISOString();
  if (!existing) {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO user_library (id, user_id, game_id, status, user_rating, notes, started_at, completed_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, userId, gameId, data.status || 'wishlist', data.user_rating ?? null,
      data.notes || '', data.started_at || null, data.completed_at || null, now, now);
    return getLibraryEntry(userId, gameId);
  }
  const fields = [], params = [];
  for (const k of ['status','user_rating','notes','started_at','completed_at']) {
    if (data[k] !== undefined) { fields.push(`${k} = ?`); params.push(data[k] ?? null); }
  }
  fields.push('updated_at = ?'); params.push(now);
  params.push(userId, gameId);
  db.prepare(`UPDATE user_library SET ${fields.join(', ')} WHERE user_id = ? AND game_id = ?`).run(...params);
  return getLibraryEntry(userId, gameId);
}

function removeLibraryEntry(userId, gameId) {
  db.prepare('DELETE FROM user_library WHERE user_id = ? AND game_id = ?').run(userId, gameId);
}

function getLibraryStats(userId) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS cnt FROM user_library WHERE user_id = ? GROUP BY status
  `).all(userId);
  const byStatus = { playing: 0, backlog: 0, completed: 0, dropped: 0, wishlist: 0 };
  let total = 0;
  for (const r of rows) { byStatus[r.status] = r.cnt; total += r.cnt; }
  const ptRow = db.prepare(`
    SELECT COALESCE(SUM(duration_min), 0) AS total FROM playtime_sessions
    WHERE user_id = ? AND ended_at IS NOT NULL
  `).get(userId);
  return { total, byStatus, totalPlaytimeMin: ptRow.total };
}

// ── Playtime Sessions ─────────────────────────────────────────────────────────

function listSessions(userId, gameId) {
  return db.prepare(`
    SELECT * FROM playtime_sessions WHERE user_id = ? AND game_id = ? ORDER BY started_at DESC
  `).all(userId, gameId);
}

function getSessionById(id) {
  return db.prepare('SELECT * FROM playtime_sessions WHERE id = ?').get(id) || null;
}

function startSession(userId, gameId, notes = '') {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO playtime_sessions (id, user_id, game_id, started_at, notes)
    VALUES (?,?,?,?,?)
  `).run(id, userId, gameId, now, notes);
  return getSessionById(id);
}

function endSession(sessionId, notes) {
  const session = getSessionById(sessionId);
  if (!session || session.ended_at) return session;
  const now = new Date().toISOString();
  const durationMin = Math.max(0, Math.floor((new Date(now) - new Date(session.started_at)) / 60000));
  const updates = ['ended_at = ?', 'duration_min = ?'];
  const params  = [now, durationMin];
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
  params.push(sessionId);
  db.prepare(`UPDATE playtime_sessions SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return getSessionById(sessionId);
}

function createManualSession(userId, gameId, { started_at, ended_at, duration_min, notes = '' }) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO playtime_sessions (id, user_id, game_id, started_at, ended_at, duration_min, notes)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, userId, gameId, started_at, ended_at, duration_min, notes);
  return getSessionById(id);
}

function deleteSession(id) {
  db.prepare('DELETE FROM playtime_sessions WHERE id = ?').run(id);
}

function getPlaytime(userId, gameId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(duration_min), 0) AS total FROM playtime_sessions
    WHERE user_id = ? AND game_id = ? AND ended_at IS NOT NULL
  `).get(userId, gameId);
  return { total_min: row.total, sessions: listSessions(userId, gameId) };
}

function getOpenSession(userId, gameId) {
  return db.prepare(`
    SELECT * FROM playtime_sessions WHERE user_id = ? AND game_id = ? AND ended_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  `).get(userId, gameId) || null;
}

// ── Genres & Platforms ────────────────────────────────────────────────────────

function listGenres() { return db.prepare('SELECT * FROM genres ORDER BY name').all(); }
function createGenre(name) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO genres (id, name) VALUES (?,?)').run(id, name);
  return { id, name };
}
function deleteGenre(id) { db.prepare('DELETE FROM genres WHERE id = ?').run(id); }

function listPlatforms() { return db.prepare('SELECT * FROM platforms ORDER BY name').all(); }
function createPlatform(name) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO platforms (id, name) VALUES (?,?)').run(id, name);
  return { id, name };
}
function deletePlatform(id) { db.prepare('DELETE FROM platforms WHERE id = ?').run(id); }

module.exports = {
  listGames, getGameById, createGame, updateGame, deleteGame,
  getLibraryEntry, listLibrary, upsertLibraryEntry, removeLibraryEntry, getLibraryStats,
  listSessions, getSessionById, startSession, endSession, createManualSession,
  deleteSession, getPlaytime, getOpenSession,
  listGenres, createGenre, deleteGenre,
  listPlatforms, createPlatform, deletePlatform,
};

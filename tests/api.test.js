/**
 * tests/api.test.js
 * Integration tests for the Games backend API.
 * Uses in-memory SQLite (NODE_ENV=test) — no cleanup needed.
 */

process.env.NODE_ENV = 'test';

const request = require('supertest');
const app     = require('../server');

// ── Auth bootstrap ─────────────────────────────────────────────────────────────

let adminToken;

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/setup')
    .send({
      firstName: 'Games',
      lastName:  'Admin',
      username:  'gamesadmin',
      password:  'gamespass123',
    });
  expect(res.status).toBe(200);
  adminToken = res.body.token;
  expect(adminToken).toBeDefined();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function authGet(url) {
  return request(app).get(url).set('x-hub-session', adminToken);
}

function authPost(url, body) {
  return request(app).post(url).set('x-hub-session', adminToken).send(body);
}

function authPut(url, body) {
  return request(app).put(url).set('x-hub-session', adminToken).send(body);
}

function authDelete(url) {
  return request(app).delete(url).set('x-hub-session', adminToken);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('GET /api/auth/status', () => {
  it('returns loggedIn:true with valid token', async () => {
    const res = await authGet('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.loggedIn).toBe(true);
    expect(res.body.user.username).toBe('gamesadmin');
  });

  it('returns loggedIn:false with no token', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.loggedIn).toBe(false);
  });

  it('returns loggedIn:false with invalid token', async () => {
    const res = await request(app).get('/api/auth/status').set('x-hub-session', 'bad-token');
    expect(res.status).toBe(200);
    expect(res.body.loggedIn).toBe(false);
  });
});

describe('POST /api/auth/setup', () => {
  it('rejects duplicate setup when users already exist', async () => {
    const res = await request(app).post('/api/auth/setup').send({
      firstName: 'Another', lastName: 'Admin', username: 'admin2', password: 'pass',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already complete/i);
  });
});

describe('POST /api/auth/login', () => {
  it('returns token on valid credentials', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ username: 'gamesadmin', password: 'gamespass123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.password).toBeUndefined();
  });

  it('returns 401 for wrong password', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ username: 'gamesadmin', password: 'wrongpass' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for unknown username', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ username: 'nobody', password: 'pass' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('logs out with a temporary token', async () => {
    const login = await request(app).post('/api/auth/login')
      .send({ username: 'gamesadmin', password: 'gamespass123' });
    const tempToken = login.body.token;
    const res = await request(app).post('/api/auth/logout').set('x-hub-session', tempToken);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('GET /api/me', () => {
  it('returns current user without password', async () => {
    const res = await authGet('/api/me');
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('gamesadmin');
    expect(res.body.password).toBeUndefined();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });
});

// ── Games Catalog ─────────────────────────────────────────────────────────────

describe('Games Catalog', () => {
  let gameId;

  it('POST /api/games creates a game (admin)', async () => {
    const res = await authPost('/api/games', {
      title: 'Test Game', description: 'A test game',
      developer: 'Test Dev', release_year: 2024,
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.title).toBe('Test Game');
    gameId = res.body.id;
  });

  it('POST /api/games returns 400 without title', async () => {
    const res = await authPost('/api/games', { description: 'No title' });
    expect(res.status).toBe(400);
  });

  it('POST /api/games returns 401 without auth', async () => {
    const res = await request(app).post('/api/games').send({ title: 'Sneaky' });
    expect(res.status).toBe(401);
  });

  it('GET /api/games returns array with library entry', async () => {
    const res = await authGet('/api/games');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const game = res.body.find(g => g.title === 'Test Game');
    expect(game).toBeDefined();
    expect('libraryEntry' in game).toBe(true);
  });

  it('GET /api/games/:id returns a single game with libraryEntry', async () => {
    const res = await authGet(`/api/games/${gameId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(gameId);
    expect('libraryEntry' in res.body).toBe(true);
  });

  it('GET /api/games/:id returns 404 for unknown id', async () => {
    const res = await authGet('/api/games/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('PUT /api/games/:id updates the game (admin)', async () => {
    const res = await authPut(`/api/games/${gameId}`, { title: 'Updated Game', description: 'Changed' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated Game');
  });

  it('PUT /api/games/:id returns 404 for unknown id', async () => {
    const res = await authPut('/api/games/fake-id', { title: 'X' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/games/:id removes the game (admin)', async () => {
    const create = await authPost('/api/games', { title: 'To Delete' });
    const res = await authDelete(`/api/games/${create.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('DELETE /api/games/:id returns 404 for unknown id', async () => {
    const res = await authDelete('/api/games/fake-id');
    expect(res.status).toBe(404);
  });
});

// ── User Library ──────────────────────────────────────────────────────────────

describe('User Library', () => {
  let gameId;

  beforeAll(async () => {
    const res = await authPost('/api/games', { title: 'Library Game' });
    gameId = res.body.id;
  });

  it('POST /api/library adds a game to the library', async () => {
    const res = await authPost('/api/library', { game_id: gameId, status: 'playing' });
    expect(res.status).toBe(201);
    expect(res.body.game_id).toBe(gameId);
    expect(res.body.status).toBe('playing');
  });

  it('POST /api/library returns 400 without game_id', async () => {
    const res = await authPost('/api/library', { status: 'wishlist' });
    expect(res.status).toBe(400);
  });

  it('POST /api/library returns 404 for unknown game', async () => {
    const res = await authPost('/api/library', { game_id: 'nonexistent', status: 'wishlist' });
    expect(res.status).toBe(404);
  });

  it('GET /api/library returns user library entries', async () => {
    const res = await authGet('/api/library');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(e => e.game_id === gameId)).toBe(true);
  });

  it('GET /api/library/stats returns stats object', async () => {
    const res = await authGet('/api/library/stats');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  it('PUT /api/library/:game_id updates library entry', async () => {
    const res = await authPut(`/api/library/${gameId}`, { status: 'completed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  });

  it('PUT /api/library/:game_id returns 404 for unknown game', async () => {
    const res = await authPut('/api/library/nonexistent', { status: 'wishlist' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/library/:game_id removes the entry', async () => {
    const res = await authDelete(`/api/library/${gameId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Playtime Sessions ─────────────────────────────────────────────────────────

describe('Playtime Sessions', () => {
  let gameId;
  let sessionId;

  beforeAll(async () => {
    const res = await authPost('/api/games', { title: 'Session Game' });
    gameId = res.body.id;
  });

  it('GET /api/games/:id/playtime returns playtime data', async () => {
    const res = await authGet(`/api/games/${gameId}/playtime`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  it('POST /api/games/:id/sessions/start starts a session', async () => {
    const res = await authPost(`/api/games/${gameId}/sessions/start`, { notes: 'Test run' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.game_id).toBe(gameId);
    sessionId = res.body.id;
  });

  it('POST sessions/start on game with open session closes the old one first', async () => {
    // Starting again should close the previous open session and create a new one
    const res = await authPost(`/api/games/${gameId}/sessions/start`, {});
    expect(res.status).toBe(201);
    const newSessionId = res.body.id;
    expect(newSessionId).not.toBe(sessionId);
    sessionId = newSessionId;
  });

  it('POST /api/games/:id/sessions/start returns 404 for unknown game', async () => {
    const res = await authPost('/api/games/fake-id/sessions/start', {});
    expect(res.status).toBe(404);
  });

  it('POST /api/games/:id/sessions/:sid/end ends the session', async () => {
    const res = await authPost(`/api/games/${gameId}/sessions/${sessionId}/end`, { notes: 'Done' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(sessionId);
    expect(res.body.ended_at).toBeDefined();
  });

  it('POST sessions/:sid/end returns 404 for unknown session', async () => {
    const res = await authPost(`/api/games/${gameId}/sessions/fake-sid/end`, {});
    expect(res.status).toBe(404);
  });

  it('POST /api/games/:id/sessions creates a manual session', async () => {
    const now = new Date().toISOString();
    const earlier = new Date(Date.now() - 3600000).toISOString();
    const res = await authPost(`/api/games/${gameId}/sessions`, {
      started_at: earlier, ended_at: now, duration_min: 60, notes: 'Logged manually',
    });
    expect(res.status).toBe(201);
    expect(res.body.duration_min).toBe(60);
  });

  it('POST manual session returns 400 when required fields are missing', async () => {
    const res = await authPost(`/api/games/${gameId}/sessions`, { notes: 'incomplete' });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/games/:id/sessions/:sid deletes a session', async () => {
    const now = new Date().toISOString();
    const earlier = new Date(Date.now() - 1800000).toISOString();
    const created = await authPost(`/api/games/${gameId}/sessions`, {
      started_at: earlier, ended_at: now, duration_min: 30,
    });
    const res = await authDelete(`/api/games/${gameId}/sessions/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('DELETE session returns 404 for unknown session', async () => {
    const res = await authDelete(`/api/games/${gameId}/sessions/fake-sid`);
    expect(res.status).toBe(404);
  });
});

// ── Genres ────────────────────────────────────────────────────────────────────

describe('Genres', () => {
  let genreId;

  it('GET /api/genres returns array', async () => {
    const res = await authGet('/api/genres');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/genres creates a genre (admin)', async () => {
    const res = await authPost('/api/genres', { name: 'TestGenre' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('TestGenre');
    genreId = res.body.id;
  });

  it('POST /api/genres returns 400 without name', async () => {
    const res = await authPost('/api/genres', {});
    expect(res.status).toBe(400);
  });

  it('POST /api/genres returns 401 without auth', async () => {
    const res = await request(app).post('/api/genres').send({ name: 'RPG' });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/genres/:id removes a genre (admin)', async () => {
    const res = await authDelete(`/api/genres/${genreId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Platforms ─────────────────────────────────────────────────────────────────

describe('Platforms', () => {
  let platformId;

  it('GET /api/platforms returns array', async () => {
    const res = await authGet('/api/platforms');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/platforms creates a platform (admin)', async () => {
    const res = await authPost('/api/platforms', { name: 'TestPlatform' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('TestPlatform');
    platformId = res.body.id;
  });

  it('POST /api/platforms returns 400 without name', async () => {
    const res = await authPost('/api/platforms', {});
    expect(res.status).toBe(400);
  });

  it('POST /api/platforms returns 401 without auth', async () => {
    const res = await request(app).post('/api/platforms').send({ name: 'PS5' });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/platforms/:id removes a platform (admin)', async () => {
    const res = await authDelete(`/api/platforms/${platformId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

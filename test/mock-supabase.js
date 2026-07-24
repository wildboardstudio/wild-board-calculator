// Minimal in-memory mock of the subset of Supabase Auth (GoTrue) + PostgREST
// used by index.html, for local acceptance testing only (real Supabase is
// unreachable from this sandbox's egress policy). Not a security-accurate
// mock — RLS/JWT validation is skipped since production RLS is already
// confirmed working per the spec; this only exercises the app's client logic.
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.argv[2] ? parseInt(process.argv[2], 10) : 8901;

// ---- state ----
const users = new Map(); // email -> {id, password, created_at}
const tokens = new Map(); // access_token -> user_id
let lists = []; // {id, user_id, name, data, updated_at}
let shop = []; // {id, user_id, data, updated_at}
let hours = []; // {id, user_id, data, updated_at}
let projectRows = []; // {id, user_id, data, updated_at}
let profiles = []; // {id, ...} — id === user_id

// test-control knobs, toggled via /_test/* endpoints
let FAIL_ALL = false;
let POST_LISTS_DELAY_MS = 0; // artificial delay on POST /rest/v1/lists, to deterministically exercise the save-then-fetch race
let quoteRows = []; // {id, user_id, data, updated_at}
let FAIL_DELETE_ACCOUNT_STEP = null; // 'lists' | 'shop' | 'profiles' | 'user' | null

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function uuid() {
  return crypto.randomUUID();
}
function randToken() {
  return crypto.randomBytes(24).toString('hex');
}
function nowIso() {
  return new Date().toISOString();
}

function sessionForUser(user) {
  const access_token = 'tok_' + randToken();
  tokens.set(access_token, user.id);
  return {
    access_token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'ref_' + randToken(),
    user: {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      email_confirmed_at: nowIso(),
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      created_at: user.created_at,
      updated_at: user.created_at
    }
  };
}

function userIdFromAuth(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m) return null;
  return tokens.get(m[1]) || null;
}

function send(res, status, body, extraHeaders) {
  const headers = Object.assign(
    {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
    },
    extraHeaders || {}
  );
  res.writeHead(status, headers);
  if (body === undefined) res.end();
  else res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', (c) => (chunks += c));
    req.on('end', () => {
      if (!chunks) return resolve({});
      try {
        resolve(JSON.parse(chunks));
      } catch (e) {
        resolve({});
      }
    });
  });
}

// Very small subset of PostgREST filter parsing: only "eq." is used by the app.
function matchesFilters(row, query) {
  for (const [key, val] of query.entries()) {
    if (key === 'select' || key === 'order' || key === 'limit' || key === 'on_conflict') continue;
    const m = /^eq\.(.*)$/.exec(val);
    if (m && row[key] !== m[1]) return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const query = url.searchParams;

  if (req.method === 'OPTIONS') {
    return send(res, 204, undefined);
  }

  // ---- test control endpoints ----
  if (path === '/_test/reset') {
    users.clear();
    tokens.clear();
    lists = [];
    shop = [];
    hours = [];
    projectRows = [];
    quoteRows = [];
    profiles = [];
    FAIL_ALL = false;
    POST_LISTS_DELAY_MS = 0;
    FAIL_DELETE_ACCOUNT_STEP = null;
    return send(res, 200, { ok: true });
  }
  if (path === '/_test/fail' && req.method === 'POST') {
    const body = await parseBody(req);
    FAIL_ALL = !!body.fail;
    return send(res, 200, { ok: true, FAIL_ALL });
  }
  if (path === '/_test/delay-list-save' && req.method === 'POST') {
    const body = await parseBody(req);
    POST_LISTS_DELAY_MS = parseInt(body.ms, 10) || 0;
    return send(res, 200, { ok: true, POST_LISTS_DELAY_MS });
  }
  if (path === '/_test/fail-delete-account-step' && req.method === 'POST') {
    const body = await parseBody(req);
    FAIL_DELETE_ACCOUNT_STEP = body.step || null;
    return send(res, 200, { ok: true, FAIL_DELETE_ACCOUNT_STEP });
  }
  if (path === '/_test/seed-profile' && req.method === 'POST') {
    const body = await parseBody(req);
    profiles.push({ id: body.user_id, username: body.username || null, company_name: body.company_name || null, email: body.email || null });
    return send(res, 200, { ok: true });
  }
  if (path === '/_test/seed-profile-settings' && req.method === 'POST') {
    const body = await parseBody(req);
    const existing = profiles.find(p => p.id === body.user_id);
    if (existing) { existing.settings = body.settings; }
    else { profiles.push({ id: body.user_id, settings: body.settings }); }
    return send(res, 200, { ok: true });
  }
  if (path === '/_test/seed-quotes' && req.method === 'POST') {
    const body = await parseBody(req);
    quoteRows.push({ id: body.id || uuid(), user_id: body.user_id, data: body.data, updated_at: nowIso() });
    return send(res, 200, { ok: true });
  }
  if (path === '/_test/seed-projects' && req.method === 'POST') {
    const body = await parseBody(req);
    projectRows.push({ id: body.id || uuid(), user_id: body.user_id, data: body.data, updated_at: nowIso() });
    return send(res, 200, { ok: true });
  }
  if (path === '/_test/dump') {
    return send(res, 200, { users: [...users.values()], lists, shop, hours, projects: projectRows, quotes: quoteRows, profiles });
  }

  if (FAIL_ALL) {
    return send(res, 500, { message: 'simulated network/server failure' });
  }

  // ---- auth ----
  if (path === '/auth/v1/signup' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.email || !body.password) {
      return send(res, 400, { error: 'invalid_request', error_description: 'Missing email or password', msg: 'Missing email or password' });
    }
    if (users.has(body.email)) {
      return send(res, 400, { error: 'user_already_exists', error_description: 'User already registered', msg: 'User already registered' });
    }
    const user = { id: uuid(), email: body.email, password: body.password, created_at: nowIso() };
    users.set(body.email, user);
    return send(res, 200, sessionForUser(user));
  }

  if (path === '/auth/v1/token' && req.method === 'POST') {
    const grantType = query.get('grant_type');
    const body = await parseBody(req);
    if (grantType === 'password') {
      const user = users.get(body.email);
      if (!user || user.password !== body.password) {
        return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials' });
      }
      return send(res, 200, sessionForUser(user));
    }
    if (grantType === 'refresh_token') {
      // find any user tied to a previously-issued token; test harness doesn't
      // rely on real refresh-token rotation, so just re-mint for the same user
      // by scanning tokens map (best-effort, fine for this mock).
      const anyUser = [...users.values()][0];
      if (!anyUser) return send(res, 400, { error: 'invalid_grant', msg: 'no user' });
      return send(res, 200, sessionForUser(anyUser));
    }
    return send(res, 400, { error: 'unsupported_grant_type' });
  }

  if (path === '/auth/v1/logout' && req.method === 'POST') {
    const auth = req.headers['authorization'] || '';
    const m = /^Bearer (.+)$/.exec(auth);
    if (m) tokens.delete(m[1]);
    return send(res, 204, undefined);
  }

  if (path === '/auth/v1/recover' && req.method === 'POST') {
    // Password reset email — always succeeds (email sending is external)
    return send(res, 200, {});
  }

  if (path === '/auth/v1/user' && req.method === 'GET') {
    const uid = userIdFromAuth(req);
    if (!uid) return send(res, 401, { message: 'not authenticated' });
    const user = [...users.values()].find((u) => u.id === uid);
    if (!user) return send(res, 401, { message: 'not authenticated' });
    return send(res, 200, sessionForUser(user).user);
  }

  if (path === '/auth/v1/user' && req.method === 'PUT') {
    const uid = userIdFromAuth(req);
    if (!uid) return send(res, 401, { message: 'not authenticated' });
    const user = [...users.values()].find((u) => u.id === uid);
    if (!user) return send(res, 401, { message: 'not authenticated' });
    const body = await parseBody(req);
    if (body.email) user.email = body.email;
    return send(res, 200, sessionForUser(user).user);
  }

  // ---- edge function: delete-account ----
  // Mirrors supabase/functions/delete-account/index.ts: derive the user id
  // from the caller's own bearer token (never trust a body-supplied id),
  // delete lists/shop/profiles rows then the auth user itself, in that
  // order, aborting (without deleting anything further) on the first
  // failure — mimicking the real function's atomicity guarantee.
  if (path === '/functions/v1/delete-account' && req.method === 'POST') {
    const uid = userIdFromAuth(req);
    if (!uid) return send(res, 401, { error: 'Invalid or expired session' });

    if (FAIL_DELETE_ACCOUNT_STEP === 'lists') {
      return send(res, 500, { error: 'Failed to delete saved lists — nothing was deleted, please retry' });
    }
    lists = lists.filter((r) => r.user_id !== uid);

    if (FAIL_DELETE_ACCOUNT_STEP === 'shop') {
      return send(res, 500, { error: 'Failed to delete shop data — please retry' });
    }
    shop = shop.filter((r) => r.user_id !== uid);

    if (FAIL_DELETE_ACCOUNT_STEP === 'hours') {
      return send(res, 500, { error: 'Failed to delete hours data — please retry' });
    }
    hours = hours.filter((r) => r.user_id !== uid);

    if (FAIL_DELETE_ACCOUNT_STEP === 'projects') {
      return send(res, 500, { error: 'Failed to delete projects — please retry' });
    }
    projectRows = projectRows.filter((r) => r.user_id !== uid);

    if (FAIL_DELETE_ACCOUNT_STEP === 'quotes') {
      return send(res, 500, { error: 'Failed to delete quotes — please retry' });
    }
    quoteRows = quoteRows.filter((r) => r.user_id !== uid);

    if (FAIL_DELETE_ACCOUNT_STEP === 'profiles') {
      return send(res, 500, { error: 'Failed to delete profile — please retry' });
    }
    profiles = profiles.filter((r) => r.id !== uid);

    if (FAIL_DELETE_ACCOUNT_STEP === 'user') {
      return send(res, 500, { error: 'Your data was removed but your login could not be deleted — please retry or contact support' });
    }
    const email = [...users.entries()].find(([, u]) => u.id === uid)?.[0];
    if (email) users.delete(email);
    for (const [tok, tokUid] of [...tokens.entries()]) {
      if (tokUid === uid) tokens.delete(tok);
    }

    return send(res, 200, { success: true });
  }

  // ---- rest: lists ----
  if (path === '/rest/v1/lists') {
    if (req.method === 'GET') {
      const rows = lists.filter((r) => matchesFilters(r, query));
      rows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      return send(res, 200, rows.map((r) => ({ data: r.data, updated_at: r.updated_at })));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      if (POST_LISTS_DELAY_MS > 0) await sleep(POST_LISTS_DELAY_MS);
      const idx = lists.findIndex((r) => r.id === body.id);
      if (idx >= 0) lists[idx] = body;
      else lists.push(body);
      return send(res, 201, undefined);
    }
    if (req.method === 'DELETE') {
      const before = lists.length;
      lists = lists.filter((r) => !matchesFilters(r, query));
      return send(res, 204, undefined);
    }
  }

  // ---- rest: shop ----
  if (path === '/rest/v1/shop') {
    if (req.method === 'GET') {
      const rows = shop.filter((r) => matchesFilters(r, query));
      return send(res, 200, rows.map((r) => ({ data: r.data })));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const idx = shop.findIndex((r) => r.id === body.id);
      if (idx >= 0) shop[idx] = body;
      else shop.push(body);
      return send(res, 201, undefined);
    }
  }

  // ---- rest: hours ----
  if (path === '/rest/v1/hours') {
    if (req.method === 'GET') {
      const rows = hours.filter((r) => matchesFilters(r, query));
      return send(res, 200, rows.map((r) => ({ data: r.data })));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const idx = hours.findIndex((r) => r.id === body.id);
      if (idx >= 0) hours[idx] = body;
      else hours.push(body);
      return send(res, 201, undefined);
    }
  }

  // ---- rest: projects ----
  if (path === '/rest/v1/projects') {
    if (req.method === 'GET') {
      const rows = projectRows.filter((r) => matchesFilters(r, query));
      return send(res, 200, rows.map((r) => ({ id: r.id, data: r.data })));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const idx = projectRows.findIndex((r) => r.id === body.id);
      if (idx >= 0) projectRows[idx] = body;
      else projectRows.push(body);
      return send(res, 201, undefined);
    }
    if (req.method === 'DELETE') {
      projectRows = projectRows.filter((r) => !matchesFilters(r, query));
      return send(res, 204, undefined);
    }
  }

  // ---- rest: quotes ----
  if (path === '/rest/v1/quotes') {
    if (req.method === 'GET') {
      const rows = quoteRows.filter((r) => matchesFilters(r, query));
      return send(res, 200, rows.map((r) => ({ id: r.id, data: r.data })));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const idx = quoteRows.findIndex((r) => r.id === body.id);
      if (idx >= 0) quoteRows[idx] = body;
      else quoteRows.push(body);
      return send(res, 201, undefined);
    }
    if (req.method === 'DELETE') {
      quoteRows = quoteRows.filter((r) => !matchesFilters(r, query));
      return send(res, 204, undefined);
    }
  }

  // ---- rest: profiles (settings + account) ----
  if (path === '/rest/v1/profiles') {
    if (req.method === 'GET') {
      const rows = profiles.filter((r) => matchesFilters(r, query));
      const select = query.get('select');
      return send(res, 200, rows.map((r) => {
        const out = {};
        if (!select || select.includes('settings')) out.settings = r.settings || null;
        if (!select || select.includes('username')) out.username = r.username || null;
        if (!select || select.includes('company_name')) out.company_name = r.company_name || null;
        if (!select || select.includes('first_name')) out.first_name = r.first_name || null;
        if (!select || select.includes('last_name')) out.last_name = r.last_name || null;
        if (!select || select.includes('email')) out.email = r.email || null;
        if (!select || select.includes('id')) out.id = r.id;
        return out;
      }));
    }
    if (req.method === 'PATCH') {
      const body = await parseBody(req);
      const userId = query.get('id')?.replace('eq.', '');
      if (userId) {
        const existing = profiles.find(p => p.id === userId);
        if (existing) {
          if (body.settings !== undefined) existing.settings = body.settings;
          if (body.username !== undefined) existing.username = body.username;
          if (body.company_name !== undefined) existing.company_name = body.company_name;
          if (body.first_name !== undefined) existing.first_name = body.first_name;
          if (body.last_name !== undefined) existing.last_name = body.last_name;
          if (body.email !== undefined) existing.email = body.email;
        } else {
          profiles.push({ id: userId, settings: body.settings, username: body.username, company_name: body.company_name, first_name: body.first_name, last_name: body.last_name, email: body.email });
        }
      }
      return send(res, 204, undefined);
    }
  }

  send(res, 404, { message: 'mock: no route for ' + req.method + ' ' + path });
});

server.listen(PORT, () => {
  console.log('mock supabase listening on ' + PORT);
});

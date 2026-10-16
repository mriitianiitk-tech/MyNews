export interface Env {
  DB: D1Database;
  NEWSDATA_API_KEY: string;
  BOOTSTRAP_TOKEN?: string;
  APP_ORIGIN?: string;
  DAILY_CREDIT_CAP?: string;
  SESSION_TTL_HOURS?: string;
}

type UserRow = { id: string; username: string; password_hash: string; password_salt: string; role: 'admin' | 'user'; is_active: number; created_at: string; updated_at: string; last_login_at: string | null };
type SessionUser = { id: string; username: string; role: 'admin' | 'user'; is_active: number };
const encoder = new TextEncoder();
const json = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const fail = (message: string, status = 400) => json({ error: message }, status);
const uid = () => crypto.randomUUID();
const bytesToHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (length = 32) => { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return bytesToHex(bytes); };
const sha256 = async (value: string) => bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 310_000, hash: 'SHA-256' }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}
function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) { const [key, ...value] = part.trim().split('='); if (key === name) return value.join('='); }
  return null;
}
function isSecureContext(request?: Request) {
  if (!request) return true;
  try {
    const url = new URL(request.url);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return false;
    return url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  } catch { return true; }
}
function cookieHeader(request: Request, value: string, maxAge: number) {
  const secure = isSecureContext(request) ? ' Secure;' : '';
  return `mynews_session=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie(request?: Request) {
  const secure = request && !isSecureContext(request) ? '' : ' Secure;';
  return `mynews_session=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`;
}
function allowedOrigin(request: Request, env: Env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const requestUrl = new URL(request.url);
    return origin === requestUrl.origin ||
      (env.APP_ORIGIN && origin === env.APP_ORIGIN) ||
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1';
  } catch { return false; }
}
async function bodyJson(request: Request) { try { return await request.json() as Record<string, unknown>; } catch { return null; } }
function cleanString(value: unknown, max = 200) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function validUsername(value: string) { return /^[a-zA-Z0-9._-]{3,32}$/.test(value); }
async function sessionUser(request: Request, env: Env): Promise<SessionUser | null> {
  const token = cookieValue(request, 'mynews_session'); if (!token) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(`SELECT u.id,u.username,u.role,u.is_active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1`).bind(hash).first<SessionUser>();
  if (!row || row.is_active !== 1) return null;
  return row;
}
async function consumeCredit(env: Env) {
  const cap = Math.max(1, Math.min(200, Number.parseInt(env.DAILY_CREDIT_CAP || '160', 10) || 160));
  const date = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(`INSERT INTO api_usage (usage_date,credits_used) VALUES (?,1) ON CONFLICT(usage_date) DO UPDATE SET credits_used=credits_used+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE credits_used < ? RETURNING credits_used`).bind(date, cap).first<{ credits_used: number }>();
  if (!row) return { ok: false, cap, used: (await env.DB.prepare('SELECT credits_used FROM api_usage WHERE usage_date=?').bind(date).first<{ credits_used: number }>())?.credits_used || 0 };
  return { ok: true, cap, used: row.credits_used };
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname; const method = request.method.toUpperCase();
  if (!allowedOrigin(request, env)) return fail('Origin not allowed.', 403);
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Allow': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' } });
  if (path === '/api/health' && method === 'GET') return json({ ok: true, app: 'MyNews' });

  if (path === '/api/setup/status' && method === 'GET') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>();
    return json({ setupRequired: (count?.count || 0) === 0 });
  }
  if (path === '/api/setup/bootstrap' && method === 'POST') {
    if (!env.BOOTSTRAP_TOKEN || !env.BOOTSTRAP_TOKEN.trim()) return fail('Bootstrap is not configured. Set BOOTSTRAP_TOKEN as a Worker secret.', 503);
    const data = await bodyJson(request); if (!data) return fail('Invalid JSON.');
    const suppliedToken = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || '';
    if (suppliedToken.length < 32 || !(await constantTimeEqual(await sha256(suppliedToken), await sha256(env.BOOTSTRAP_TOKEN)))) return fail('Invalid bootstrap token.', 403);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>();
    if ((count?.count || 0) !== 0) return fail('Initial setup has already been completed.', 409);
    const password = typeof data.password === 'string' ? data.password.slice(0, 200) : ''; const username = 'admin';
    if (password.length < 14) return fail('Initial password must be at least 14 characters long.');
    const salt = randomHex(16); const hash = await passwordHash(password, salt); const id = uid();
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO users (id,username,password_hash,password_salt,role,is_active) VALUES (?,?,?,?,\'admin\',1)').bind(id, username, hash, salt),
        env.DB.prepare("INSERT INTO app_state (key,value) VALUES ('bootstrap_complete','true') ON CONFLICT(key) DO UPDATE SET value='true', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
      ]);
    } catch { return fail('Bootstrap could not create the administrator. Check database migration and retry only if no user was created.', 500); }
    return json({ ok: true, username, message: 'Administrator created. Remove the BOOTSTRAP_TOKEN secret after setup.' }, 201);
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const data = await bodyJson(request); if (!data) return fail('Invalid JSON.');
    const username = cleanString(data.username, 32); const password = typeof data.password === 'string' ? data.password.slice(0, 200) : '';
    if (!username || !password) return fail('Username and password are required.', 400);
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    const attemptKey = await sha256(`${clientIp}:${username.toLowerCase()}`);
    const attempt = await env.DB.prepare("SELECT attempts,window_started_at FROM login_attempts WHERE attempt_key=?").bind(attemptKey).first<{ attempts: number; window_started_at: string }>();
    if (attempt && new Date(attempt.window_started_at).getTime() > Date.now() - 15 * 60_000 && attempt.attempts >= 10) return fail('Too many failed attempts. Wait 15 minutes before trying again.', 429);
    const user = await env.DB.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE LIMIT 1').bind(username).first<UserRow>();
    // Perform a hash operation for unknown usernames too, reducing obvious timing differences.
    const candidate = await passwordHash(password, user?.password_salt || 'mynews-invalid-user-salt');
    if (!user || user.is_active !== 1 || !(await constantTimeEqual(candidate, user.password_hash))) {
      await env.DB.prepare("INSERT INTO login_attempts (attempt_key,attempts,window_started_at) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(attempt_key) DO UPDATE SET attempts=CASE WHEN window_started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') THEN 1 ELSE attempts+1 END, window_started_at=CASE WHEN window_started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE window_started_at END, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(attemptKey).run();
      return fail('Invalid username or password.', 401);
    }
    await env.DB.prepare('DELETE FROM login_attempts WHERE attempt_key=?').bind(attemptKey).run();
    const token = randomHex(32); const tokenHash = await sha256(token);
    const hours = Math.max(1, Math.min(720, Number.parseInt(env.SESSION_TTL_HOURS || '168', 10) || 168));
    const expires = new Date(Date.now() + hours * 3600_000).toISOString();
    await env.DB.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(tokenHash, user.id, expires).run();
    await env.DB.prepare("UPDATE users SET last_login_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(user.id).run();
    return json({ user: { id: user.id, username: user.username, role: user.role } }, 200, { 'Set-Cookie': cookieHeader(request, token, hours * 3600) });
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    const token = cookieValue(request, 'mynews_session'); if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(request) });
  }
  if (path === '/api/auth/me' && method === 'GET') {
    const user = await sessionUser(request, env); return user ? json({ user: { id: user.id, username: user.username, role: user.role } }) : fail('Not signed in.', 401);
  }

  // All routes below require a valid session.
  const current = await sessionUser(request, env);
  if (!current) return fail('Authentication required.', 401);

  if (path === '/api/admin/users' && method === 'GET') {
    if (current.role !== 'admin') return fail('Administrator access required.', 403);
    const result = await env.DB.prepare('SELECT id,username,role,is_active,created_at,updated_at,last_login_at FROM users ORDER BY created_at ASC').all();
    return json({ users: result.results });
  }
  if (path === '/api/admin/users' && method === 'POST') {
    if (current.role !== 'admin') return fail('Administrator access required.', 403);
    const data = await bodyJson(request); if (!data) return fail('Invalid JSON.');
    const username = cleanString(data.username, 32); const password = typeof data.password === 'string' ? data.password.slice(0, 200) : ''; const role = data.role === 'admin' ? 'admin' : 'user';
    if (!validUsername(username)) return fail('Username must be 3–32 characters and contain only letters, numbers, dots, underscores or hyphens.');
    if (password.length < 14) return fail('Password must be at least 14 characters long.');
    const salt = randomHex(16); const hash = await passwordHash(password, salt); const id = uid();
    try { await env.DB.prepare('INSERT INTO users (id,username,password_hash,password_salt,role,is_active) VALUES (?,?,?,?,?,1)').bind(id, username, hash, salt, role).run(); }
    catch { return fail('Could not create user. The username may already exist.', 409); }
    return json({ user: { id, username, role, is_active: 1 } }, 201);
  }
  const userMatch = path.match(/^\/api\/admin\/users\/([0-9a-f-]+)$/i);
  if (userMatch && ['PATCH', 'DELETE'].includes(method)) {
    if (current.role !== 'admin') return fail('Administrator access required.', 403);
    const targetId = userMatch[1]; const target = await env.DB.prepare('SELECT id,username,role,is_active FROM users WHERE id=?').bind(targetId).first<{ id: string; username: string; role: string; is_active: number }>();
    if (!target) return fail('User not found.', 404);
    if (method === 'DELETE') {
      if (target.id === current.id) return fail('You cannot delete the account you are currently using.', 400);
      if (target.role === 'admin') {
        const admins = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND is_active=1").first<{ count: number }>();
        if ((admins?.count || 0) <= 1) return fail('Cannot delete the last active administrator.', 400);
      }
      await env.DB.prepare('DELETE FROM users WHERE id=?').bind(targetId).run();
      return json({ ok: true });
    }
    const data = await bodyJson(request); if (!data) return fail('Invalid JSON.');
    const username = data.username === undefined ? target.username : cleanString(data.username, 32);
    const role = data.role === 'admin' ? 'admin' : data.role === 'user' ? 'user' : target.role;
    const isActive = typeof data.is_active === 'boolean' ? (data.is_active ? 1 : 0) : target.is_active;
    if (!validUsername(username)) return fail('Invalid username format.');
    if (target.id === current.id && (role !== 'admin' || isActive !== 1)) return fail('You cannot demote or deactivate your own current administrator account.', 400);
    if (target.role === 'admin' && (role !== 'admin' || isActive === 0)) {
      const admins = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND is_active=1").first<{ count: number }>();
      if ((admins?.count || 0) <= 1) return fail('Cannot deactivate or demote the last active administrator.', 400);
    }
    const password = data.password === undefined ? '' : (typeof data.password === 'string' ? data.password.slice(0, 200) : '');
    if (password && password.length < 14) return fail('New password must be at least 14 characters long.');
    if (password) {
      const salt = randomHex(16); const hash = await passwordHash(password, salt);
      await env.DB.prepare("UPDATE users SET username=?,role=?,is_active=?,password_hash=?,password_salt=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(username, role, isActive, hash, salt, targetId).run();
      await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId).run();
    } else {
      await env.DB.prepare("UPDATE users SET username=?,role=?,is_active=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(username, role, isActive, targetId).run();
      if (isActive === 0) await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId).run();
    }
    return json({ ok: true });
  }

  if (path === '/api/usage' && method === 'GET') {
    const date = new Date().toISOString().slice(0, 10); const cap = Math.max(1, Math.min(200, Number.parseInt(env.DAILY_CREDIT_CAP || '160', 10) || 160));
    const used = (await env.DB.prepare('SELECT credits_used FROM api_usage WHERE usage_date=?').bind(date).first<{ credits_used: number }>())?.credits_used || 0;
    return json({ date, used, cap, remaining: Math.max(0, cap - used) });
  }

function buildNewsDataUrl(query: Record<string, any>, apiKey: string): { url: string; params: URLSearchParams; effectiveApiKey: string } {
  let params: URLSearchParams;
  const raw = query.raw_url && typeof query.raw_url === 'string' ? query.raw_url.trim() : '';

  if (raw) {
    try {
      const parsed = new URL(raw);
      params = new URLSearchParams(parsed.search);
    } catch {
      params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
    }
  } else {
    params = new URLSearchParams();
    const mode = ['q', 'qInTitle', 'qInMeta'].includes(query.query_mode) ? query.query_mode : 'q';
    if (query.expression) params.set(mode, query.expression);
    if (query.country) params.set('country', query.country);
    if (query.language) params.set('language', query.language);
    if (query.category) params.set('category', query.category);
    if (query.domains) params.set('domain', query.domains);
    if (query.sentiment) params.set('sentiment', query.sentiment);
    if (query.sort) params.set('sort', query.sort);
    if (query.removeduplicate !== undefined && query.removeduplicate !== null && query.removeduplicate !== '' && query.removeduplicate !== 0) {
      params.set('removeduplicate', '1');
    }
    if (query.from_date) params.set('from_date', query.from_date);
    if (query.to_date) params.set('to_date', query.to_date);

    if (query.custom_params && typeof query.custom_params === 'string') {
      try {
        const extra = new URLSearchParams(query.custom_params.startsWith('?') ? query.custom_params.slice(1) : query.custom_params);
        extra.forEach((val, key) => { if (!params.has(key)) params.set(key, val); });
      } catch {}
    }
  }

  // Handle excluded domains
  if (query.exclude_domains && typeof query.exclude_domains === 'string' && query.exclude_domains.trim()) {
    const existing = (params.get('excludedomain') || '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
    const additional = query.exclude_domains.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
    const combined = Array.from(new Set([...existing, ...additional]));
    if (combined.length) params.set('excludedomain', combined.join(','));
  }

  // Determine effective API key (either embedded in raw_url/params or provided by environment)
  const effectiveApiKey = (params.get('apikey') || apiKey || '').trim();

  // Ensure apiKey is present
  if (effectiveApiKey && !params.get('apikey')) {
    params.set('apikey', effectiveApiKey);
  }

  return { url: `https://newsdata.io/api/1/latest?${params.toString()}`, params, effectiveApiKey };
}

  if (path === '/api/queries' && method === 'GET') {
    const result = await env.DB.prepare('SELECT id,name,enabled,query_mode,expression,country,language,category,domains,exclude_domains,from_date,to_date,raw_url,sentiment,sort,removeduplicate,custom_params,created_at,updated_at FROM queries WHERE user_id=? ORDER BY created_at DESC').bind(current.id).all();
    const queries = result.results.map((q: any) => ({
      ...q,
      generated_url: buildNewsDataUrl(q, env.NEWSDATA_API_KEY || '').url
    }));
    return json({ queries });
  }
  if (path === '/api/queries' && method === 'POST') {
    const data = await bodyJson(request); if (!data) return fail('Invalid JSON.');
    let rawUrl = cleanString(data.raw_url, 2000);
    let name = cleanString(data.name, 100);
    let expression = cleanString(data.expression, 500);
    let mode = ['q', 'qInTitle', 'qInMeta'].includes(String(data.query_mode)) ? String(data.query_mode) : 'q';
    let country = cleanString(data.country, 100) || null;
    let language = cleanString(data.language, 100) || null;
    let category = cleanString(data.category, 150) || null;
    let domains = cleanString(data.domains, 300) || null;
    let excludeDomains = cleanString(data.exclude_domains, 500) || null;
    let sentiment = cleanString(data.sentiment, 30) || null;
    let sort = cleanString(data.sort, 30) || null;
    let removeduplicate = data.removeduplicate ? 1 : 0;
    let customParams = cleanString(data.custom_params, 1000) || null;
    const fromDate = cleanString(data.from_date, 20) || null;
    const toDate = cleanString(data.to_date, 20) || null;

    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        const sp = parsed.searchParams;
        if (!expression) {
          if (sp.get('qInMeta')) { mode = 'qInMeta'; expression = sp.get('qInMeta') || ''; }
          else if (sp.get('qInTitle')) { mode = 'qInTitle'; expression = sp.get('qInTitle') || ''; }
          else if (sp.get('q')) { mode = 'q'; expression = sp.get('q') || ''; }
        }
        if (!country && sp.get('country')) country = sp.get('country');
        if (!language && sp.get('language')) language = sp.get('language');
        if (!category && sp.get('category')) category = sp.get('category');
        if (!domains && (sp.get('domain') || sp.get('domains'))) domains = sp.get('domain') || sp.get('domains');
        if (!excludeDomains && sp.get('excludedomain')) excludeDomains = sp.get('excludedomain');
        if (!sentiment && sp.get('sentiment')) sentiment = sp.get('sentiment');
        if (!sort && sp.get('sort')) sort = sp.get('sort');
        if (data.removeduplicate === undefined && sp.get('removeduplicate')) removeduplicate = sp.get('removeduplicate') === '1' ? 1 : 0;
      } catch {}
    }

    if (!name && expression) name = expression.slice(0, 80);
    if (!name || (!expression && !rawUrl)) return fail('Query name and search expression or URL are required.');

    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM queries WHERE user_id=?').bind(current.id).first<{ count: number }>();
    if ((count?.count || 0) >= 20) return fail('Maximum saved queries reached.', 409);
    const id = uid();
    await env.DB.prepare('INSERT INTO queries (id,user_id,name,enabled,query_mode,expression,country,language,category,domains,exclude_domains,from_date,to_date,raw_url,sentiment,sort,removeduplicate,custom_params) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, current.id, name, data.enabled === false ? 0 : 1, mode, expression, country, language, category, domains, excludeDomains, fromDate, toDate, rawUrl || null, sentiment, sort, removeduplicate, customParams).run();
    return json({ id, name, enabled: data.enabled === false ? 0 : 1 }, 201);
  }
  const queryMatch = path.match(/^\/api\/queries\/([0-9a-f-]+)$/i);
  if (queryMatch && ['PATCH', 'PUT', 'DELETE'].includes(method)) {
    const query = await env.DB.prepare('SELECT id FROM queries WHERE id=? AND user_id=?').bind(queryMatch[1], current.id).first<{ id: string }>();
    if (!query) return fail('Query not found.', 404);
    if (method === 'DELETE') { await env.DB.prepare('DELETE FROM queries WHERE id=? AND user_id=?').bind(query.id, current.id).run(); return json({ ok: true }); }
    const data = await bodyJson(request); if (!data) return fail('Invalid JSON.');
    const fields: string[] = []; const values: unknown[] = [];
    const allowed: Record<string, [string, (v: unknown) => unknown]> = {
      name: ['name', v => cleanString(v, 100)],
      expression: ['expression', v => cleanString(v, 500)],
      country: ['country', v => cleanString(v, 100) || null],
      language: ['language', v => cleanString(v, 100) || null],
      category: ['category', v => cleanString(v, 150) || null],
      domains: ['domains', v => cleanString(v, 300) || null],
      exclude_domains: ['exclude_domains', v => cleanString(v, 500) || null],
      from_date: ['from_date', v => cleanString(v, 20) || null],
      to_date: ['to_date', v => cleanString(v, 20) || null],
      enabled: ['enabled', v => v === false || v === 0 ? 0 : 1],
      query_mode: ['query_mode', v => ['q', 'qInTitle', 'qInMeta'].includes(String(v)) ? String(v) : 'q'],
      raw_url: ['raw_url', v => cleanString(v, 2000) || null],
      sentiment: ['sentiment', v => cleanString(v, 30) || null],
      sort: ['sort', v => cleanString(v, 30) || null],
      removeduplicate: ['removeduplicate', v => v ? 1 : 0],
      custom_params: ['custom_params', v => cleanString(v, 1000) || null]
    };
    for (const [key, value] of Object.entries(data)) if (allowed[key]) { fields.push(`${allowed[key][0]}=?`); values.push(allowed[key][1](value)); }
    if (!fields.length) return fail('No editable fields supplied.');
    fields.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"); values.push(query.id, current.id);
    await env.DB.prepare(`UPDATE queries SET ${fields.join(',')} WHERE id=? AND user_id=?`).bind(...values).run();
    await env.DB.prepare('DELETE FROM query_articles WHERE query_id=?').bind(query.id).run();
    return json({ ok: true });
  }

  const excludeSourceMatch = path.match(/^\/api\/queries\/([0-9a-f-]+)\/exclude-source$/i);
  if (excludeSourceMatch && method === 'POST') {
    const data = await bodyJson(request); if (!data) return fail('Invalid JSON.');
    let domain = cleanString(data.domain, 150).toLowerCase();
    try {
      if (domain.includes('://')) domain = new URL(domain).hostname;
      else if (domain.includes('/')) domain = domain.split('/')[0];
    } catch {}
    domain = domain.replace(/^www\./, '').trim();
    if (!domain) return fail('A valid source domain or identifier is required.');

    const query = await env.DB.prepare('SELECT * FROM queries WHERE id=? AND user_id=?').bind(excludeSourceMatch[1], current.id).first<any>();
    if (!query) return fail('Query not found.', 404);

    const existingExcluded = (query.exclude_domains || '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
    if (!existingExcluded.includes(domain)) {
      existingExcluded.push(domain);
    }
    const updatedExcludeStr = existingExcluded.join(',');

    // If query has raw_url, update or append excludedomain parameter in raw_url
    let updatedRawUrl = query.raw_url;
    if (updatedRawUrl) {
      try {
        const u = new URL(updatedRawUrl);
        u.searchParams.set('excludedomain', updatedExcludeStr);
        updatedRawUrl = u.toString();
      } catch {
        const p = new URLSearchParams(updatedRawUrl.startsWith('?') ? updatedRawUrl.slice(1) : updatedRawUrl);
        p.set('excludedomain', updatedExcludeStr);
        updatedRawUrl = `https://newsdata.io/api/1/latest?${p.toString()}`;
      }
    }

    await env.DB.prepare("UPDATE queries SET exclude_domains=?, raw_url=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND user_id=?").bind(updatedExcludeStr, updatedRawUrl, query.id, current.id).run();
    await env.DB.prepare('DELETE FROM query_articles WHERE query_id=?').bind(query.id).run();

    return json({ ok: true, excluded: domain, exclude_domains: updatedExcludeStr });
  }

  if (path === '/api/news' && method === 'GET') {
    const queryId = cleanString(url.searchParams.get('queryId'), 64);
    const query = await env.DB.prepare('SELECT * FROM queries WHERE id=? AND user_id=? AND enabled=1').bind(queryId, current.id).first<any>();
    if (!query) return fail('Enabled query not found.', 404);
    const { url: targetUrl, params, effectiveApiKey } = buildNewsDataUrl(query, env.NEWSDATA_API_KEY || '');
    const isMockKey = !effectiveApiKey || effectiveApiKey.startsWith('test') || effectiveApiKey.startsWith('mock') || effectiveApiKey.includes('replace');

    const cached = await env.DB.prepare("SELECT a.*, COALESCE(s.is_read,0) AS is_read, COALESCE(s.is_skipped,0) AS is_skipped, COALESCE(s.is_saved,0) AS is_saved FROM query_articles qa JOIN articles a ON a.id=qa.article_id LEFT JOIN user_article_state s ON s.article_id=a.id AND s.user_id=qa.user_id WHERE qa.user_id=? AND qa.query_id=? AND qa.matched_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes') ORDER BY a.published_at DESC LIMIT 50").bind(current.id, query.id).all();
    const hasMockCached = cached.results.some((r: any) => String(r.url || '').includes('example.com') || String(r.id || '').startsWith('mock-') || String(r.source_domain || '').includes('example.com'));

    // A short global cache is returned when available and does not contain mock data (unless intentionally in mock mode). Query results are still fetched on explicit refresh.
    if (url.searchParams.get('refresh') !== '1' && cached.results.length && (!hasMockCached || isMockKey)) {
      return json({ articles: cached.results, cached: true, warning: 'Recent cached results shown. Refresh explicitly to fetch again.', queryUrl: targetUrl });
    }

    if (!effectiveApiKey) return fail('NewsData.io API key is not configured. Provide it in .dev.vars or paste the full query URL with apikey.', 503);
    const credit = await consumeCredit(env);
    if (!credit.ok) return json({ error: 'Daily application API budget reached.', usage: { used: credit.used, cap: credit.cap, remaining: 0 }, queryUrl: targetUrl }, 429);
    let payload: { status?: string; results?: Array<Record<string, unknown>>; message?: string | string[]; totalResults?: number };
    if (isMockKey) {
      payload = {
        status: 'success',
        totalResults: 3,
        results: [
          {
            article_id: `mock-${query.id}-1`,
            title: `[Demo Mock] Latest Industry Analysis on ${query.expression || query.name}`,
            link: `https://example.com/news/${encodeURIComponent(query.expression || query.name)}/1`,
            description: `Industry analysts and researchers have reported major developments regarding ${query.expression || query.name}. Early indicators point to wide adoption across key sectors.`,
            pubDate: new Date(Date.now() - 25 * 60_000).toISOString(),
            source_name: 'Global News Wire',
            source_url: 'globalnewswire.com',
            category: [query.category || 'technology'],
            country: [query.country || 'us'],
            language: query.language || 'en'
          },
          {
            article_id: `mock-${query.id}-2`,
            title: `[Demo Mock] Emerging Trends in ${query.expression || query.name}`,
            link: `https://example.com/news/${encodeURIComponent(query.expression || query.name)}/2`,
            description: `An in-depth report on emerging trends, technical improvements, and strategic implications related to ${query.expression || query.name}.`,
            pubDate: new Date(Date.now() - 95 * 60_000).toISOString(),
            source_name: 'Tech Observer',
            source_url: 'techobserver.org',
            category: [query.category || 'business'],
            country: [query.country || 'us'],
            language: query.language || 'en'
          },
          {
            article_id: `mock-${query.id}-3`,
            title: `[Demo Mock] Weekly Market Recap & Outlook for ${query.expression || query.name}`,
            link: `https://example.com/news/${encodeURIComponent(query.expression || query.name)}/3`,
            description: `A synthesis of recent reports, practical case studies, and forecasts concerning ${query.expression || query.name}.`,
            pubDate: new Date(Date.now() - 240 * 60_000).toISOString(),
            source_name: 'Daily Business Herald',
            source_url: 'businessherald.net',
            category: [query.category || 'top'],
            country: [query.country || 'us'],
            language: query.language || 'en'
          }
        ]
      };
    } else {
      let provider: Response;
      try { provider = await fetch(targetUrl, { headers: { 'Accept': 'application/json' } }); }
      catch { return fail('Could not reach NewsData.io. The application credit was reserved; try again later.', 502); }
      payload = await provider.json() as { status?: string; results?: Array<Record<string, unknown>>; message?: string | string[]; totalResults?: number };
      if (!provider.ok || payload.status === 'error') {
        const errorDetail = typeof payload.message === 'string' ? payload.message : (Array.isArray(payload.message) ? payload.message.join('; ') : `Provider returned ${provider.status}.`);
        return json({ error: 'NewsData.io request failed.', details: errorDetail, queryUrl: targetUrl }, provider.status === 429 ? 429 : 502);
      }
    }
    const articles = [];
    const dbStatements = [];
    for (const item of payload.results || []) {
      const articleUrl = cleanString(item.link, 1000); const title = cleanString(item.title, 500);
      if (!articleUrl || !title) continue;
      const id = await sha256(articleUrl);
      const categoryValue = Array.isArray(item.category) ? item.category.join(',') : cleanString(item.category, 100);
      const countryValue = Array.isArray(item.country) ? item.country.join(',') : cleanString(item.country, 100);
      const langValue = Array.isArray(item.language) ? item.language.join(',') : cleanString(item.language, 50);
      const metadata = JSON.stringify({ creator: item.creator, keywords: item.keywords, pubDate: item.pubDate, article_id: item.article_id });
      dbStatements.push(
        env.DB.prepare(`INSERT INTO articles (id,provider_id,url,title,description,image_url,source_name,source_domain,language,country,category,published_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET title=excluded.title,description=excluded.description,image_url=excluded.image_url,source_name=excluded.source_name,source_domain=excluded.source_domain,published_at=excluded.published_at,fetched_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),metadata_json=excluded.metadata_json`).bind(id, cleanString(item.article_id, 200) || null, articleUrl, title, cleanString(item.description, 3000) || null, cleanString(item.image_url, 1000) || null, cleanString(item.source_name, 200) || null, cleanString(item.source_url, 300) || null, langValue || null, countryValue || null, categoryValue || null, cleanString(item.pubDate, 50) || null, metadata),
        env.DB.prepare('INSERT INTO user_article_state (user_id,article_id) VALUES (?,?) ON CONFLICT(user_id,article_id) DO NOTHING').bind(current.id, id),
        env.DB.prepare('INSERT INTO query_articles (query_id,user_id,article_id) VALUES (?,?,?) ON CONFLICT(query_id,article_id) DO UPDATE SET matched_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')').bind(query.id, current.id, id)
      );
      articles.push({ id, url: articleUrl, title, description: cleanString(item.description, 3000), image_url: cleanString(item.image_url, 1000), source_name: cleanString(item.source_name, 200), source_domain: cleanString(item.source_url, 300), published_at: cleanString(item.pubDate, 50), category: categoryValue, is_read: 0, is_skipped: 0, is_saved: 0, match_reason: `Matched query: ${query.expression || query.name}` });
    }
    if (dbStatements.length > 0) {
      for (let i = 0; i < dbStatements.length; i += 20) {
        await env.DB.batch(dbStatements.slice(i, i + 20));
      }
    }
    return json({ articles, cached: false, totalResults: payload.totalResults || articles.length, queryUrl: targetUrl, usage: { used: credit.used, cap: credit.cap, remaining: Math.max(0, credit.cap - credit.used) } });
  }

  const articleStateMatch = path.match(/^\/api\/articles\/([a-f0-9]{64})\/state$/i);
  if (articleStateMatch && method === 'PATCH') {
    const data = await bodyJson(request); if (!data) return fail('Invalid JSON.');
    const articleId = articleStateMatch[1]; const article = await env.DB.prepare('SELECT id FROM articles WHERE id=?').bind(articleId).first(); if (!article) return fail('Article not found.', 404);
    const existing = await env.DB.prepare('SELECT is_read,is_skipped,is_saved FROM user_article_state WHERE user_id=? AND article_id=?').bind(current.id, articleId).first<{ is_read: number; is_skipped: number; is_saved: number }>();
    const state = { is_read: data.is_read === undefined ? (existing?.is_read || 0) : data.is_read ? 1 : 0, is_skipped: data.is_skipped === undefined ? (existing?.is_skipped || 0) : data.is_skipped ? 1 : 0, is_saved: data.is_saved === undefined ? (existing?.is_saved || 0) : data.is_saved ? 1 : 0 };
    await env.DB.prepare('INSERT INTO user_article_state (user_id,article_id,is_read,is_skipped,is_saved) VALUES (?,?,?,?,?) ON CONFLICT(user_id,article_id) DO UPDATE SET is_read=excluded.is_read,is_skipped=excluded.is_skipped,is_saved=excluded.is_saved,updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')').bind(current.id, articleId, state.is_read, state.is_skipped, state.is_saved).run();
    return json({ ok: true, state });
  }
  if (path === '/api/folders' && method === 'GET') {
    const result = await env.DB.prepare('SELECT f.id,f.name,f.created_at,COUNT(fa.article_id) AS article_count FROM folders f LEFT JOIN folder_articles fa ON fa.folder_id=f.id AND fa.user_id=f.user_id WHERE f.user_id=? GROUP BY f.id ORDER BY f.name').bind(current.id).all(); return json({ folders: result.results });
  }
  if (path === '/api/folders' && method === 'POST') {
    const data = await bodyJson(request); if (!data) return fail('Invalid JSON.'); const name = cleanString(data.name, 80); if (!name) return fail('Folder name is required.'); const id = uid();
    try { await env.DB.prepare('INSERT INTO folders (id,user_id,name) VALUES (?,?,?)').bind(id, current.id, name).run(); } catch { return fail('Folder name already exists.', 409); }
    return json({ id, name }, 201);
  }
  if (path === '/api/folder-articles' && method === 'POST') {
    const data = await bodyJson(request); if (!data) return fail('Invalid JSON.');
    const folderId = cleanString(data.folder_id, 64); const articleId = cleanString(data.article_id, 64);
    const folder = await env.DB.prepare('SELECT id FROM folders WHERE id=? AND user_id=?').bind(folderId, current.id).first();
    const article = await env.DB.prepare('SELECT id FROM articles WHERE id=?').bind(articleId).first();
    if (!folder || !article) return fail('Folder or article not found.', 404);
    await env.DB.prepare('INSERT INTO folder_articles (folder_id,article_id,user_id) VALUES (?,?,?) ON CONFLICT(folder_id,article_id) DO NOTHING').bind(folderId, articleId, current.id).run();
    return json({ ok: true });
  }
  if (path === '/api/folder-articles' && method === 'GET') {
    const folderId = cleanString(url.searchParams.get('folderId'), 64);
    const folder = await env.DB.prepare('SELECT id FROM folders WHERE id=? AND user_id=?').bind(folderId, current.id).first();
    if (!folder) return fail('Folder not found.', 404);
    const result = await env.DB.prepare('SELECT a.*,COALESCE(s.is_read,0) AS is_read,COALESCE(s.is_skipped,0) AS is_skipped,COALESCE(s.is_saved,0) AS is_saved FROM folder_articles fa JOIN articles a ON a.id=fa.article_id LEFT JOIN user_article_state s ON s.article_id=a.id AND s.user_id=fa.user_id WHERE fa.folder_id=? AND fa.user_id=? ORDER BY a.published_at DESC').bind(folderId, current.id).all();
    return json({ articles: result.results });
  }
  if (path === '/api/notes' && method === 'GET') {
    const result = await env.DB.prepare('SELECT id,article_id,note,updated_at FROM article_notes WHERE user_id=? ORDER BY updated_at DESC LIMIT 500').bind(current.id).all();
    return json({ notes: result.results });
  }
  if (path === '/api/bookmarks' && method === 'GET') {
    const result = await env.DB.prepare('SELECT a.*,s.is_read,s.is_skipped,s.is_saved FROM user_article_state s JOIN articles a ON a.id=s.article_id WHERE s.user_id=? AND s.is_saved=1 ORDER BY a.published_at DESC LIMIT 200').bind(current.id).all(); return json({ articles: result.results });
  }
  if (path === '/api/notes' && method === 'POST') {
    const data = await bodyJson(request); if (!data) return fail('Invalid JSON.'); const articleId = cleanString(data.article_id, 64); const note = typeof data.note === 'string' ? data.note.slice(0, 10000) : '';
    if (!articleId || !(await env.DB.prepare('SELECT id FROM articles WHERE id=?').bind(articleId).first())) return fail('Article not found.', 404);
    await env.DB.prepare("INSERT INTO article_notes (id,user_id,article_id,note) VALUES (?,?,?,?) ON CONFLICT(user_id,article_id) DO UPDATE SET note=excluded.note,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(uid(), current.id, articleId, note).run(); return json({ ok: true });
  }
  if (path === '/api/export/bookmarks' && method === 'GET') {
    const result = await env.DB.prepare('SELECT a.title,a.url,a.source_name,a.published_at,s.is_read,n.note FROM user_article_state s JOIN articles a ON a.id=s.article_id LEFT JOIN article_notes n ON n.article_id=a.id AND n.user_id=s.user_id WHERE s.user_id=? AND s.is_saved=1 ORDER BY a.published_at DESC').bind(current.id).all();
    return new Response(JSON.stringify(result.results, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="mynews-bookmarks.json"', 'Cache-Control': 'no-store' } });
  }
  return fail('Not found.', 404);
}
async function constantTimeEqual(a: string, b: string) {
  const aa = encoder.encode(a); const bb = encoder.encode(b); let diff = aa.length ^ bb.length; const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}
export default { fetch(request: Request, env: Env) { return route(request, env).catch((error: unknown) => { console.error('MyNews request error', error instanceof Error ? error.message : 'unknown'); return json({ error: 'Internal server error.' }, 500); }); } } satisfies ExportedHandler<Env>;

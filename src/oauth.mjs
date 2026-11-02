// Minimal OAuth 2.1 authorization server for one owner. Clients (claude.ai) register
// dynamically and use PKCE; the owner proves identity by signing in with GitHub,
// and only allowlisted GitHub logins get tokens. Do-It issues its own tokens.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const CODE_TTL = 300;
const MAX_CLIENTS = 50;
const MAX_PENDING = 100;
// Redirects allowed at registration: Claude's hosted callback, plus loopback for local clients.
const ALLOWED_REDIRECT = /^(https:\/\/(claude\.ai|claude\.com)\/api\/mcp\/auth_callback|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s]*)$/;

const b64url = buf => Buffer.from(buf).toString('base64url');
const sha256 = value => createHash('sha256').update(value).digest('base64url');
const random = () => b64url(randomBytes(32));
const now = () => Math.floor(Date.now() / 1000);
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class OAuth {
  constructor({ baseUrl, github, stateFile, githubBase = 'https://github.com', githubApi = 'https://api.github.com', fetchImpl = fetch }) {
    if (!github?.clientId || !github?.clientSecret || !github?.allowedLogins?.length) throw new Error('GitHub config needs clientId, clientSecret and allowedLogins.');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.resource = `${this.baseUrl}/mcp`;
    this.github = github;
    this.allowed = new Set(github.allowedLogins.map(l => l.toLowerCase()));
    this.githubBase = githubBase;
    this.githubApi = githubApi;
    this.fetch = fetchImpl;
    this.stateFile = stateFile;
    this.codes = new Map(); // our code -> grant
    this.consents = new Map(); // consent id -> signed-in request awaiting owner approval
    this.state = this.load();
  }

  load() {
    try {
      const state = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (state.key && state.clients && state.refresh) return state;
    } catch { /* first run */ }
    const state = { key: random(), clients: {}, refresh: {} };
    this.save(state);
    return state;
  }

  save(state = this.state) {
    mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }

  client(id) { return typeof id === 'string' && Object.hasOwn(this.state.clients, id) ? this.state.clients[id] : undefined; }

  // Approved clients whose refresh tokens have all lapsed expire; when still full, the oldest
  // unapproved registration makes room, so public registrations never lock out approved clients.
  pruneClients() {
    const live = new Set(Object.values(this.state.refresh).filter(r => r.exp >= now()).map(r => r.clientId));
    for (const [id, c] of Object.entries(this.state.clients)) {
      if (c.approved && !live.has(id) && c.created < now() - REFRESH_TTL) delete this.state.clients[id];
    }
    const unapproved = Object.entries(this.state.clients).filter(([, c]) => !c.approved).sort((a, b) => a[1].created - b[1].created);
    while (Object.keys(this.state.clients).length >= MAX_CLIENTS && unapproved.length) delete this.state.clients[unapproved.shift()[0]];
  }

  protectedResourceMetadata() {
    return { resource: this.resource, authorization_servers: [this.baseUrl], bearer_methods_supported: ['header'] };
  }

  authorizationServerMetadata() {
    return {
      issuer: this.baseUrl,
      authorization_endpoint: `${this.baseUrl}/authorize`,
      token_endpoint: `${this.baseUrl}/token`,
      registration_endpoint: `${this.baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    };
  }

  register(body) {
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every(u => typeof u === 'string' && ALLOWED_REDIRECT.test(u) && URL.canParse(u))) {
      return error(400, 'invalid_redirect_uri', 'Only Claude callback or loopback redirect URIs are accepted.');
    }
    const method = body.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return error(400, 'invalid_client_metadata', 'Unsupported token_endpoint_auth_method.');
    const clientId = random();
    const secret = method === 'none' ? undefined : random();
    this.pruneClients();
    if (Object.keys(this.state.clients).length >= MAX_CLIENTS) return error(503, 'temporarily_unavailable', 'Too many registered clients; try again later.');
    this.state.clients[clientId] = { redirect_uris: uris, method, secretHash: secret && sha256(secret), name: String(body.client_name ?? '').slice(0, 100), created: now() };
    this.save();
    return json(201, {
      client_id: clientId, ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
      client_id_issued_at: now(), redirect_uris: uris, token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
  }

  // Validates the client's request, then sends the browser to GitHub.
  authorize(params) {
    const client = this.client(params.get('client_id'));
    const redirectUri = params.get('redirect_uri');
    if (!client || !client.redirect_uris.includes(redirectUri)) return html(400, 'Unknown client or redirect URI.');
    const fail = (code, description) => redirect(withQuery(redirectUri, { error: code, error_description: description, state: params.get('state') }));
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only code is supported.');
    if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(params.get('code_challenge') ?? '')) return fail('invalid_request', 'PKCE S256 is required.');
    const resource = params.get('resource');
    if (resource && resource.replace(/\/$/, '') !== this.resource) return fail('invalid_target', 'Unknown resource.');
    if ((params.get('state') ?? '').length > 512) return fail('invalid_request', 'state is too long.');
    // The request rides through GitHub inside a signed state, so nothing is stored before sign-in.
    const payload = b64url(JSON.stringify({
      t: 'github-state', clientId: params.get('client_id'), redirectUri, state: params.get('state'),
      challenge: params.get('code_challenge'), exp: now() + 600,
    }));
    const githubState = `${payload}.${this.sign(payload)}`;
    return redirect(withQuery(`${this.githubBase}/login/oauth/authorize`, {
      client_id: this.github.clientId, redirect_uri: `${this.baseUrl}/oauth/github/callback`,
      state: githubState, scope: '', allow_signup: 'false',
    }));
  }

  async githubCallback(params) {
    const request = this.readSigned(params.get('state'), 'github-state');
    if (!request || request.exp < now()) return html(400, 'Sign-in expired. Start again from Claude.');
    const back = query => redirect(withQuery(request.redirectUri, { ...query, state: request.state }));
    if (!params.get('code')) return back({ error: 'access_denied', error_description: 'GitHub sign-in was cancelled.' });
    let login;
    try {
      const tokenResponse = await this.fetch(`${this.githubBase}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.github.clientId, client_secret: this.github.clientSecret, code: params.get('code'), redirect_uri: `${this.baseUrl}/oauth/github/callback` }),
        signal: AbortSignal.timeout(10_000),
      });
      const { access_token: githubToken } = await tokenResponse.json();
      if (!githubToken) throw new Error('no token');
      const userResponse = await this.fetch(`${this.githubApi}/user`, {
        headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json', 'user-agent': 'do-it' },
        signal: AbortSignal.timeout(10_000),
      });
      login = (await userResponse.json()).login;
    } catch {
      return back({ error: 'server_error', error_description: 'GitHub sign-in failed.' });
    }
    if (typeof login !== 'string' || !this.allowed.has(login.toLowerCase())) {
      return back({ error: 'access_denied', error_description: 'This GitHub account is not allowed.' });
    }
    const client = this.client(request.clientId);
    if (!client) return back({ error: 'invalid_client', error_description: 'Client no longer registered.' });
    if (client.approved) return back({ code: this.issueCode(request, login) });
    // First sign-in for this client: the owner must approve it on a Do-It page, so a
    // forwarded sign-in link cannot silently mint a token for someone else's client.
    this.prune(this.consents);
    if (this.consents.size >= MAX_PENDING) return back({ error: 'temporarily_unavailable', error_description: 'Too many pending approvals.' });
    const consentId = random();
    this.consents.set(consentId, { ...request, login, exp: now() + 600 });
    const where = new URL(request.redirectUri).host;
    return html(200, `<h1>Allow access to Do-It?</h1>
<p>Signed in to GitHub as <b>${escapeHtml(login)}</b>. A client named <b>${escapeHtml(client.name || 'unnamed')}</b>
wants control of Claude Code on this server. It will return to <b>${escapeHtml(where)}</b>.</p>
<p>Approve only if you just clicked Connect in Claude yourself.</p>
<form method="post" action="${this.baseUrl}/consent">
<input type="hidden" name="id" value="${consentId}">
<button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Deny</button>
</form>`);
  }

  consent(form) {
    const request = this.consents.get(form.get('id'));
    this.consents.delete(form.get('id'));
    if (!request || request.exp < now()) return html(400, 'This approval expired. Start again from Claude.');
    const back = query => redirect(withQuery(request.redirectUri, { ...query, state: request.state }));
    const client = this.client(request.clientId);
    if (form.get('decision') !== 'approve' || !client) return back({ error: 'access_denied', error_description: 'Access was denied.' });
    client.approved = true;
    this.save();
    return back({ code: this.issueCode(request, request.login) });
  }

  issueCode(request, login) {
    this.prune(this.codes);
    const code = random();
    this.codes.set(code, { clientId: request.clientId, redirectUri: request.redirectUri, challenge: request.challenge, login, exp: now() + CODE_TTL });
    return code;
  }

  token(form, authorization) {
    const { clientId, ok } = this.authenticateClient(form, authorization);
    if (!ok) return error(401, 'invalid_client', 'Client authentication failed.');
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const code = this.codes.get(form.get('code'));
      this.codes.delete(form.get('code'));
      if (!code || code.exp < now() || code.clientId !== clientId || code.redirectUri !== form.get('redirect_uri')) return error(400, 'invalid_grant', 'Invalid or expired code.');
      if (!safeEqual(sha256(form.get('code_verifier') ?? ''), code.challenge)) return error(400, 'invalid_grant', 'PKCE verification failed.');
      return json(200, this.issue(clientId, code.login));
    }
    if (grant === 'refresh_token') {
      const hash = sha256(form.get('refresh_token') ?? '');
      const entry = this.state.refresh[hash];
      if (!entry || entry.exp < now() || entry.clientId !== clientId) return error(400, 'invalid_grant', 'Invalid refresh token.');
      delete this.state.refresh[hash]; // rotate
      return json(200, this.issue(clientId, entry.login));
    }
    return error(400, 'unsupported_grant_type', 'Unsupported grant type.');
  }

  authenticateClient(form, authorization) {
    let clientId = form.get('client_id');
    let secret = form.get('client_secret');
    if (authorization?.startsWith('Basic ')) {
      const [id, pass] = Buffer.from(authorization.slice(6), 'base64').toString().split(':');
      try {
        clientId = decodeURIComponent(id ?? '');
        secret = decodeURIComponent(pass ?? '');
      } catch { return { ok: false }; }
    }
    const client = this.client(clientId);
    if (!client) return { ok: false };
    if (client.method === 'none') return { clientId, ok: true };
    return { clientId, ok: safeEqual(sha256(secret ?? ''), client.secretHash) };
  }

  issue(clientId, login) {
    for (const [hash, entry] of Object.entries(this.state.refresh)) if (entry.exp < now()) delete this.state.refresh[hash];
    const refresh = random();
    this.state.refresh[sha256(refresh)] = { clientId, login, exp: now() + REFRESH_TTL };
    this.save();
    const payload = b64url(JSON.stringify({ sub: login, cid: clientId, aud: this.resource, exp: now() + ACCESS_TTL }));
    return { access_token: `${payload}.${this.sign(payload)}`, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh };
  }

  readSigned(value, type) {
    const [payload, signature] = String(value ?? '').split('.');
    if (!payload || !safeEqual(signature, this.sign(payload))) return undefined;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return data.t === type ? data : undefined;
    } catch { return undefined; }
  }

  sign(payload) { return createHmac('sha256', this.state.key).update(payload).digest('base64url'); }

  // Returns the owner's login for a valid access token, else undefined.
  verify(authorization) {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    const [payload, signature] = authorization.slice(7).trim().split('.');
    if (!payload || !safeEqual(signature, this.sign(payload))) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (claims.aud !== this.resource || claims.exp < now() || !this.allowed.has(String(claims.sub).toLowerCase())) return undefined;
      return claims.sub;
    } catch { return undefined; }
  }

  unauthorized() {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${this.baseUrl}/.well-known/oauth-protected-resource"` },
    });
  }

  prune(map) { for (const [k, v] of map) if (v.exp < now()) map.delete(k); }
}

function withQuery(url, query) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const error = (status, code, description) => json(status, { error: code, error_description: description });
const redirect = location => new Response(null, { status: 302, headers: { location } });
const html = (status, body) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Do-It</title><body style="font:16px system-ui;max-width:32rem;margin:2rem auto;padding:0 1rem">${body}`, {
  status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'cache-control': 'no-store' },
});
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

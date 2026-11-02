// Do-It: an MCP server that lets a remote Claude (for example a claude.ai chat) list,
// read, start, steer and stop Claude Code sessions on this machine, inside the folders
// you allow. It listens on localhost only; put an HTTPS tunnel in front of it, and every
// MCP request needs an OAuth bearer token.
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { configDirFrom, loadConfig, stateDirFrom, watchConfig, watchGithub } from './config.mjs';
import { Driving } from './driving.mjs';
import { OAuth } from './oauth.mjs';
import { PERMISSION_MODES, SESSION_ID, Sessions, UserError } from './sessions.mjs';

const { version: VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const sessionId = z.string().regex(SESSION_ID, 'sessionId must be a session UUID from list_sessions, or at least its first 8 characters.').describe('Session UUID from list_sessions, or at least its first 8 characters.');
const permissionMode = z.enum(PERMISSION_MODES).optional().describe('Defaults to auto: actions run without prompts, with a safety classifier. bypassPermissions is refused unless the server allows it.');
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function createMcpServer(sessions) {
  const server = new McpServer({ name: 'do-it', version: VERSION });
  const tool = (name, description, inputSchema, annotations, fn) =>
    server.registerTool(name, { description, inputSchema: z.object(inputSchema).strict(), annotations }, async args => {
      try {
        const value = await fn(args);
        return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
      } catch (error) {
        const message = error instanceof UserError ? error.message : 'Internal error.';
        if (!(error instanceof UserError)) console.error(error);
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    });

  tool('list_sessions',
    "List Claude Code sessions in the allowed folders, newest first, with live status (idle, busy, waiting, not running) and statusLine: the opening sentence of each session's latest reply. Titles are set when a chat starts and can go stale; statusLine is current.",
    { cwd: z.string().optional().describe('Only sessions in this absolute folder or below it.'), limit: z.number().int().min(1).max(100).optional().describe('Sessions to return, default 20.') },
    read, args => sessions.list(args));

  tool('read_session',
    "Read a session's most recent messages (text only; tool calls shown as [tool: Name]). Use it to check progress, results and any question the session is waiting on.",
    { sessionId, limit: z.number().int().min(1).max(50).optional().describe('Messages to return, default 10.'), maxChars: z.number().int().min(500).max(50_000).optional().describe('Total characters to return, default 12000.') },
    read, ({ sessionId: id, ...options }) => sessions.read(id, options));

  tool('start_session',
    'Start a new background Claude Code session in an allowed folder with a first prompt. Returns its sessionId. The session runs on its own; check it with read_session.',
    { cwd: z.string().describe('Absolute path of an existing folder inside the allowed folders.'), prompt: z.string().min(1).max(20_000), name: z.string().max(80).optional().describe('Display name for the session.'), permissionMode },
    write, args => sessions.start(args));

  tool('send_message',
    "Send a message to an existing session to steer it, answer its question or give it new work. It continues in the background under the same id with its own saved settings. A busy session needs interrupt: true. Sessions open in an interactive window (desktop app, terminal, Remote Control) are refused: close them there first. permissionMode applies only to sessions that were never background sessions.",
    { sessionId, text: z.string().min(1).max(20_000), permissionMode,
      interrupt: z.boolean().optional().describe('If the session is busy, stop its current turn first. Default false: a busy session is left alone.') },
    write, ({ sessionId: id, text, ...options }) => sessions.send(id, text, options));

  tool('stop_session',
    'Stop a running background session. Its conversation is kept and can be continued later with send_message. Sessions open in an interactive window are stopped there.',
    { sessionId },
    { ...write, destructiveHint: true }, ({ sessionId: id }) => sessions.stop(id));

  return server;
}

// Routes OAuth endpoints, then gates /mcp on a valid bearer token.
export function createApp({ oauth, sessions = new Sessions() }) {
  const mcp = createMcpHandler(() => createMcpServer(sessions), { onerror: error => console.error(`MCP error: ${error.message}`) });
  const fetchHandler = async request => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case 'GET /.well-known/oauth-protected-resource':
      case 'GET /.well-known/oauth-protected-resource/mcp':
        return Response.json(oauth.protectedResourceMetadata());
      case 'GET /.well-known/oauth-authorization-server':
        return Response.json(oauth.authorizationServerMetadata());
      case 'POST /register':
        return oauth.register(await readSmall(request).then(JSON.parse).catch(() => null));
      case 'GET /authorize':
        return oauth.authorize(url.searchParams);
      case 'GET /oauth/github/callback':
        return oauth.githubCallback(url.searchParams);
      case 'POST /token':
        return oauth.token(new URLSearchParams(await readSmall(request).catch(() => '')), request.headers.get('authorization'));
      case 'POST /consent':
        return oauth.consent(new URLSearchParams(await readSmall(request).catch(() => '')));
    }
    if (url.pathname === '/mcp') {
      if (!oauth.verify(request.headers.get('authorization'))) return oauth.unauthorized();
      return mcp.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  };
  return { fetch: fetchHandler, close: () => mcp.close() };
}

// Public OAuth endpoints only ever need a few KB.
async function readSmall(request, max = 16_384) {
  if (Number(request.headers.get('content-length') ?? 0) > max) throw new Error('too large');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    size += r.value.length;
    if (size > max) { await reader.cancel(); throw new Error('too large'); }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// node:http <-> fetch bridge.
export function listen(app, { host = '127.0.0.1', port = 8787 } = {}) {
  const http = createHttpServer(async (req, res) => {
    try {
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(new URL(req.url, `http://${host}`), {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]])),
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? 'half' : undefined,
      });
      const response = await app.fetch(request);
      // Access log: path only (queries carry OAuth codes), plus who called and with what protocol.
      const h = req.headers;
      console.log(`${req.method} ${new URL(req.url, 'http://x').pathname} ${response.status} from=${h['x-forwarded-for'] ?? '-'} ua=${JSON.stringify(h['user-agent'] ?? '')} accept=${JSON.stringify(h.accept ?? '')} mcp-version=${h['mcp-protocol-version'] ?? '-'}`);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      // pipeline() handles a failing body (an SSE stream that errors) and a client that goes
      // away, closing the response instead of leaving an unhandled 'error' event.
      if (response.body) {
        pipeline(Readable.fromWeb(response.body), res, error => {
          if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(`Response stream error: ${error.message}`);
        });
      } else res.end();
    } catch (error) {
      console.error(`HTTP bridge error: ${error.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  http.listen(port, host);
  // Open keep-alive and SSE connections would keep close() waiting, so they are closed too.
  const close = async () => {
    const closed = new Promise(resolve => http.close(() => resolve()));
    http.closeAllConnections();
    await Promise.allSettled([app.close(), closed]);
  };
  return { http, close };
}

// Starts the server with the settings in DO_IT_CONFIG_DIR (default ~/.config/do-it).
export function main(env = process.env) {
  const configDir = configDirFrom(env);
  const port = Number(env.DO_IT_PORT ?? 8787);
  let settings, sessions, oauth;
  try {
    settings = loadConfig(configDir, env);
    // No turn is in flight at startup, so any registered turn is a leftover from a crash.
    // DO_IT_STATE_DIR, else ~/.local/state/do-it; the hook resolves it the same way.
    const driving = new Driving({ dir: path.join(stateDirFrom(env), 'driving') });
    driving.clear();
    sessions = new Sessions({ roots: settings.roots, allowBypassPermissions: settings.allowBypassPermissions, driving });
    oauth = new OAuth({ baseUrl: settings.baseUrl, github: settings.github, stateFile: path.join(stateDirFrom(env), 'oauth.json') });
  } catch (error) { console.error(error.message); process.exit(1); }
  const { baseUrl } = settings;
  const describe = () => `allowed folders: ${sessions.roots.join(', ') || 'none (every tool refuses until allowedRoots is set)'}${sessions.allowBypassPermissions ? '; bypassPermissions allowed' : ''}`;
  const stopWatching = watchConfig(configDir, live => {
    try { sessions.configure(live); console.log(`config.json changed; ${describe()}`); }
    catch (error) { console.error(`Ignoring config.json change, keeping the previous settings: ${error.message}`); }
  });
  // A login removed from allowedLogins loses access at its next request, without a restart.
  const stopWatchingGithub = watchGithub(configDir, github => {
    try { oauth.configureGithub(github); console.log(`github.json changed; allowed logins: ${github.allowedLogins.join(', ')}`); }
    catch (error) { console.error(`Ignoring github.json change, keeping the previous settings: ${error.message}`); }
  });
  const server = listen(createApp({ oauth, sessions }), { port });
  server.http.once('listening', () => console.log(`Do-It ${VERSION} on http://127.0.0.1:${port}/mcp, public ${baseUrl}/mcp, ${describe()}`));
  // Exit once connections are closed; a stuck close still exits after a few seconds.
  const stop = () => {
    stopWatching();
    stopWatchingGithub();
    setTimeout(() => process.exit(0), 5000).unref();
    server.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

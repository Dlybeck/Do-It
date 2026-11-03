// Getting the GitHub app Do-It signs you in with.
//
// createGithubApp uses GitHub's app-manifest flow: Do-It serves a small page that sends your
// browser to GitHub with the app's settings filled in, you click "Create GitHub App", GitHub
// sends the browser back to Do-It with a one-time code, and Do-It trades the code for the
// client ID and secret. That page lives for a few minutes on the instance's own port, under a
// random path, and is reached through the public address, so the browser can be on any device.
// manualAppUrl is the fallback: a prefilled "New OAuth App" form to copy two values from.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body style="font:16px system-ui;max-width:32rem;margin:2rem auto;padding:0 1rem">${body}`;

export const callbackUrl = publicUrl => `${publicUrl}/oauth/github/callback`;

// The "New OAuth App" form with its fields filled in through the query string.
export function manualAppUrl(publicUrl) {
  const query = new URLSearchParams({ 'oauth_application[name]': 'Do-It', 'oauth_application[url]': publicUrl, 'oauth_application[callback_url]': callbackUrl(publicUrl) });
  return `https://github.com/settings/applications/new?${query}`;
}

// The app's settings, as GitHub's manifest format wants them. The name must be unique across
// GitHub and at most 34 characters.
export function appManifest({ publicUrl, login, token, suffix = randomBytes(2).toString('hex') }) {
  return {
    name: `Do-It ${String(login ?? '').slice(0, 20)} ${suffix}`.replace(/\s+/g, ' ').trim(),
    url: publicUrl,
    description: 'Sign-in for Do-It, which lets Claude control Claude Code on one machine. It reads your GitHub login and nothing else.',
    redirect_url: `${publicUrl}/setup/github/${token}/callback`,
    callback_urls: [callbackUrl(publicUrl)],
    public: false,
  };
}

// Runs the flow. Resolves { clientId, clientSecret, slug, htmlUrl }. Rejects with an Error whose
// message says what to do instead when the flow can't run (nothing here is partly done).
//   onReady({ url, localUrl, token })  the link to open, once the page is up
export async function createGithubApp({ publicUrl, port, login, fetchImpl = fetch, onReady = () => {}, timeoutMs = 10 * 60_000, pingForMs = 45_000, pingEveryMs = 3000, host = '127.0.0.1', apiBase = 'https://api.github.com', formBase = 'https://github.com' }) {
  const token = randomBytes(24).toString('base64url');
  const base = `/setup/github/${token}`;
  const manifest = appManifest({ publicUrl, login, token });
  let finish, fail;
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  done.catch(() => {}); // a rejection before anyone awaits it is reported below

  const send = (res, status, body, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'GET' || !url.pathname.startsWith(base)) return send(res, 404, 'Not found', 'text/plain');
    const route = url.pathname.slice(base.length) || '/';
    if (route === '/ping') return send(res, 200, 'ok', 'text/plain');
    if (route === '/') {
      return send(res, 200, page('Create the Do-It GitHub app', `<h1>Create the Do-It GitHub app</h1>
<p>Sending you to GitHub. There, check the details and click <b>Create GitHub App</b>.</p>
<form id="f" method="post" action="${formBase}/settings/apps/new?state=${token}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<noscript><button>Continue to GitHub</button></noscript></form>
<script>document.getElementById('f').submit()</script>`));
    }
    if (route === '/callback') {
      const code = url.searchParams.get('code') ?? '';
      if (url.searchParams.get('state') !== token || !/^[A-Za-z0-9]+$/.test(code)) return send(res, 400, page('Do-It', '<p>That sign-in link is not valid. Start again from the terminal.</p>'));
      try {
        const response = await fetchImpl(`${apiBase}/app-manifests/${code}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json', 'user-agent': 'do-it' }, signal: AbortSignal.timeout(15_000) });
        const app = await response.json();
        if (response.status !== 201 || !app.client_id || !app.client_secret) throw new Error(`GitHub answered ${response.status}${app.message ? `: ${app.message}` : ''}`);
        send(res, 200, page('Do-It', `<h1>Done</h1><p>The GitHub app <b>${escapeHtml(app.name ?? app.slug ?? '')}</b> is created. You can close this tab and go back to the terminal.</p>`));
        finish({ clientId: app.client_id, clientSecret: app.client_secret, slug: app.slug, htmlUrl: app.html_url });
      } catch (error) {
        send(res, 502, page('Do-It', '<p>GitHub did not hand over the app details. Go back to the terminal.</p>'));
        fail(new Error(`GitHub didn't hand over the new app's details (${error.message}). An app may already exist at https://github.com/settings/apps; delete it there before trying again.`));
      }
      return;
    }
    send(res, 404, 'Not found', 'text/plain');
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); })
    .catch(error => { throw new Error(error.code === 'EADDRINUSE' ? `Port ${port} is in use (is Do-It already running there? Run "do-it uninstall" first, then set up again), so the setup page can't start.` : `The setup page couldn't start: ${error.message}`); });
  const timer = setTimeout(() => fail(new Error('Nobody finished creating the app within 10 minutes.')), timeoutMs);
  try {
    // The page must be reachable through the public address, or GitHub can't send the browser back.
    // A tunnel that was only just switched on can take a while to answer, so keep trying.
    let ping;
    for (const started = Date.now(); ping !== 'ok';) {
      ping = await fetchImpl(`${publicUrl}${base}/ping`, { signal: AbortSignal.timeout(10_000) }).then(r => r.text(), () => undefined);
      if (ping === 'ok' || Date.now() - started >= pingForMs) break;
      await new Promise(resolve => setTimeout(resolve, pingEveryMs));
    }
    if (ping !== 'ok') throw new Error(`${publicUrl} doesn't reach this machine on port ${port} yet, so GitHub can't send the browser back.`);
    onReady({ url: `${publicUrl}${base}`, localUrl: `http://${host}:${port}${base}`, token });
    return await done;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

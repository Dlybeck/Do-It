// Finding out whether Tailscale can give Do-It a public https address, and turning Funnel on.
// Everything goes through an injected `exec(command, args)` so tests never touch a real tailnet.

const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };

// { dnsName, httpsAllowed, funnelAllowed, busy, own } for a running Tailscale, else undefined.
// `busy` is true when this machine already serves something through Tailscale (or when that
// can't be told): turning Funnel on for Do-It would replace it, so the caller must not do it.
// `own` is true when the only thing served is a Funnel to Do-It's own port, which is reusable.
export async function detectTailscale(exec, port = 8787) {
  const status = await exec('tailscale', ['status', '--json']);
  const data = status.ok ? parse(status.stdout) : undefined;
  if (!data || data.BackendState !== 'Running' || !data.Self?.DNSName) return undefined;
  const caps = data.Self.CapMap ?? {};
  const serve = await exec('tailscale', ['serve', 'status', '--json']);
  const config = serve.ok ? parse(serve.stdout) : undefined;
  // A failed or unreadable answer counts as busy; only "nothing is served" is safe to overwrite.
  const empty = serve.ok && (config ? !Object.keys(config.Web ?? {}).length && !Object.keys(config.TCP ?? {}).length : /no serve config/i.test(serve.stdout));
  const handlers = Object.values(config?.Web ?? {}).flatMap(site => Object.values(site.Handlers ?? {}));
  const own = Boolean(config) && Object.keys(config.Web ?? {}).length === 1 && handlers.length > 0 && handlers.every(h => String(h.Proxy).replace(/\/$/, '') === `http://127.0.0.1:${port}`);
  return { dnsName: data.Self.DNSName.replace(/\.$/, ''), httpsAllowed: 'https' in caps, funnelAllowed: 'funnel' in caps, busy: !empty, own };
}

export const funnelArgs = port => ['funnel', '--bg', '--https=443', `http://127.0.0.1:${port}`];
export const funnelCommand = port => `tailscale ${funnelArgs(port).join(' ')}`;

// Turns Funnel on for the Do-It port. Returns { ok, output }.
export async function enableFunnel(exec, port) {
  const result = await exec('tailscale', funnelArgs(port));
  return { ok: result.ok, output: [result.stdout, result.stderr].filter(Boolean).join('\n') };
}

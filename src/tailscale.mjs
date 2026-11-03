// Finding out whether Tailscale can give Do-It a public https address, and turning Funnel on.
// Everything goes through an injected `exec(command, args)` so tests never touch a real tailnet.

const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };

// { dnsName, httpsAllowed, funnelAllowed, busy } for a running Tailscale, else undefined.
// `busy` is true when this machine already serves something through Tailscale: turning Funnel
// on for Do-It would replace that, so the caller must not do it.
export async function detectTailscale(exec) {
  const status = await exec('tailscale', ['status', '--json']);
  const data = status.ok ? parse(status.stdout) : undefined;
  if (!data || data.BackendState !== 'Running' || !data.Self?.DNSName) return undefined;
  const caps = data.Self.CapMap ?? {};
  const serve = await exec('tailscale', ['serve', 'status', '--json']);
  const config = serve.ok ? parse(serve.stdout) : undefined;
  return {
    dnsName: data.Self.DNSName.replace(/\.$/, ''),
    httpsAllowed: 'https' in caps,
    funnelAllowed: 'funnel' in caps,
    busy: Boolean(config && (Object.keys(config.Web ?? {}).length || Object.keys(config.TCP ?? {}).length)),
  };
}

export const funnelArgs = port => ['funnel', '--bg', '--https=443', `http://127.0.0.1:${port}`];
export const funnelCommand = port => `tailscale ${funnelArgs(port).join(' ')}`;

// Turns Funnel on for the Do-It port. Returns { ok, output }.
export async function enableFunnel(exec, port) {
  const result = await exec('tailscale', funnelArgs(port));
  return { ok: result.ok, output: [result.stdout, result.stderr].filter(Boolean).join('\n') };
}

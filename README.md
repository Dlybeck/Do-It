# Do-It

Do-It is a small MCP server that lets a remote Claude, such as a claude.ai chat or an
always-on agent, see and drive the Claude Code sessions on your own machine. It can list
sessions, read them, start new ones, send them a message and stop them, all inside the
folders you allow.

It runs on your machine and drives your own `claude` CLI, so sessions use your Claude Code
login, your settings and your files. Do-It itself has no model access.

> **Read this first.** Do-It can run Claude Code, and Claude Code can run commands, in the
> folders you allow. Sessions it starts run in `auto` permission mode unless asked
> otherwise. Anyone who gets a Do-It access token can do the same. Sign-in is always on
> and can't be turned off. Keep the allowlist narrow, and only allow GitHub accounts you
> control.

## Requirements

- **Linux or macOS** with Node.js 22 or newer. Windows is not yet supported; see
  [Platforms](#platforms).
- Claude Code CLI, signed in with `claude auth login`. It must support background sessions
  (`claude --bg`, `claude agents`, `claude stop`).
- A public **HTTPS** address on **port 443** that forwards to Do-It. claude.ai only
  connects to remote MCP servers on port 443.
- A GitHub account. Do-It uses a GitHub OAuth App to sign you in.

## Setup

1. **Get the code.**

   ```sh
   git clone https://github.com/Dlybeck/Do-It.git && cd Do-It
   npm ci && npm link    # puts `do-it` on your PATH; or run `node bin/do-it.mjs`
   ```

2. **Give it a public HTTPS address.** With [Tailscale Funnel](https://tailscale.com/kb/1223/funnel):

   ```sh
   tailscale funnel --bg --https=443 http://127.0.0.1:8787
   ```

   Your address is `https://<machine>.<tailnet>.ts.net`, and your tailnet policy must allow
   Funnel for this machine. Any HTTPS tunnel or reverse proxy that serves a public hostname
   on port 443 and forwards to `127.0.0.1:8787` also works, for example Cloudflare Tunnel,
   ngrok, or Caddy on a server you own. If port 443 on this machine is already used by
   something else, `deploy/tailscale/serve.json` is a serve config for running Funnel from
   a separate Tailscale node in the official container.

3. **Install it as a background service.**

   ```sh
   do-it install
   ```

   If there are no settings yet, this runs `do-it setup` first. Setup asks for:
   - the folders Do-It may use
   - the GitHub login(s) allowed to sign in
   - your public address
   - the details of a GitHub OAuth App

   To get the OAuth App details, setup tells you what to enter at
   <https://github.com/settings/developers> → **New OAuth App**:
   - **Homepage URL:** your address
   - **Authorization callback URL:** `<your address>/oauth/github/callback`

   Leave device flow off, and paste the client ID and a new client secret back into setup.
   Setup writes `~/.config/do-it/config.json` and `github.json`, readable only by you.

   Then `install` sets up a service that runs as you and starts at login. It checks that
   Do-It answers on `127.0.0.1:8787`.
   - **Linux:** a systemd user unit in `~/.config/systemd/user/do-it.service`, enabled and
     started. To keep it running while you're logged out, run
     `sudo loginctl enable-linger $USER`; `install` reminds you if that's needed, but it
     never runs sudo itself.
   - **macOS:** a launchd agent in `~/Library/LaunchAgents/do-it.plist`, loaded with
     `launchctl bootstrap`. launchd starts programs with a minimal PATH, so the agent names
     `node` and the `claude` CLI by their full paths. Logs go to `~/Library/Logs/do-it.log`.

   `install` is safe to run again, for example after moving or reinstalling `claude`: it
   rewrites its own service file and restarts the service. `do-it status` shows whether the
   service is installed, running and answering. `do-it uninstall` stops it and removes only
   what `install` created; your settings and sign-in state stay. `install` and `uninstall`
   never touch a service of the same name that they didn't create. To run Do-It in the
   foreground instead, use `do-it start`.

4. **Connect.** In claude.ai, go to **Settings → Connectors → Add custom connector** and
   enter `<your address>/mcp`. Leave the OAuth client fields empty. You'll sign in with
   GitHub, then approve the client on Do-It's own page. That page only appears the first
   time a client connects; approve it only if you just clicked Connect yourself.

### A second instance

`--name` installs another instance next to the first. It gets its own config and state
folders (`~/.config/<name>`, `~/.local/state/<name>`), so give it its own `--port`:

```sh
do-it install --name do-it-test --port 8788
do-it status --name do-it-test --port 8788
do-it uninstall --name do-it-test --port 8788
```

`--config-dir`, `--state-dir` and `--claude-bin` override the folders and the path to
`claude`. Every command takes the same options.

### Setting up the service by hand

If you'd rather not use `install`, `do-it service` prints the same service file with the
full paths to `node`, Do-It and `claude` filled in. Unlike `install`, it always uses the
default name.

On Linux (systemd):

```sh
do-it service > ~/.config/systemd/user/do-it.service
systemctl --user daemon-reload && systemctl --user enable --now do-it
sudo loginctl enable-linger "$USER"   # keep it running while you're logged out
```

On macOS (launchd):

```sh
do-it service > ~/Library/LaunchAgents/do-it.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/do-it.plist
```

A file made this way has no install marker, so `do-it install` and `uninstall` leave it
alone. Remove it yourself if you switch to `install`.

## The allowlist

`allowedRoots` in `config.json` is the setting that controls what Do-It can reach. It is a
list of absolute folders, and each one includes all its subfolders.

- **Nothing is allowed by default.** Until you add a folder, every tool refuses and says
  how to fix it. Do-It runs code on your machine from the internet, so an unconfigured
  server reaches nothing rather than guessing at your home folder.
- **Add a folder with `do-it add-folder <path>`,** or edit `config.json` directly. A
  running server picks up the change within a few seconds, with no restart. If an edit
  breaks the file, the server logs it and keeps the previous settings.
- **Scope.** `list_sessions` only shows sessions whose folder is inside an allowed root.
  The other tools refuse any session or folder outside them.
- **Matching.** Paths are resolved first, so a symlink or `..` can't escape. Matching
  ignores case on macOS and Windows, as their file systems do, and is exact on Linux.
- **Not allowed as roots:** relative paths and whole file systems (`/`, `C:\`).
- **Trust prompts.** Claude Code refuses to start or resume a session in a folder it
  doesn't trust, and sessions you run in the desktop app don't write the CLI's trust
  record. So before starting or resuming a session in an allowed folder, Do-It writes the
  same entry in `~/.claude.json` that accepting the trust prompt writes. It never does this
  for folders outside the allowlist. Running Claude Code processes write that file too, so
  Do-It reads it again just before replacing it and redoes its change if it changed.

`trustedRoots`, the setting's earlier name, is still read, and `do-it setup` or
`add-folder` rename it. Upgrading from a version that had the public address built in? Add
`publicUrl` to `config.json` first, or the server won't start.

## Permission modes and `allowBypassPermissions`

Sessions start in `auto` mode by default: Claude Code's safety classifier reviews each
action. `permissionMode` can also be `acceptEdits`, `plan` or `default`.

`bypassPermissions` skips every check, so Do-It **refuses it** unless `config.json` sets:

```json
{ "allowBypassPermissions": true }
```

It is off by default. While it's off, `send_message` also won't continue a background session
that last ran in `bypassPermissions`, or one whose saved mode can't be found in its
transcript, because a background session resumes in its saved mode. Like `allowedRoots`,
the setting takes effect without a restart.

## Tools

| Tool | Inputs | What it does |
|---|---|---|
| `list_sessions` | `cwd`? (absolute folder), `limit`? (1–100, default 20) | Sessions in the allowed folders, newest first. Each row has `sessionId`, `title`, `cwd`, `status` (`idle`, `busy`, `waiting`, `not running`), `waitingFor`, `kind` (`interactive` or `background`), `lastActivity`, and `statusLine`: the opening sentence of the latest reply. Titles are set when a chat starts and can go stale, but the status line stays current. |
| `read_session` | `sessionId`, `limit`? (1–50, default 10), `maxChars`? (500–50000, default 12000) | The newest messages with text. Tool calls show as `[tool: Name]`, and tool results are left out. |
| `start_session` | `cwd` (existing folder inside the allowlist), `prompt`, `name`?, `permissionMode`? | Starts a background Claude Code session with that first prompt and returns its `sessionId`. |
| `send_message` | `sessionId`, `text`, `interrupt`? (default false), `permissionMode`? | Continues a session with a new message, under the same id. A busy session needs `interrupt: true`. |
| `stop_session` | `sessionId` | Stops a running background session. Its conversation is kept, so `send_message` can continue it later. |

`sessionId` is a full session UUID or at least its first 8 characters. A prefix that
matches more than one session is refused. A session that has run in the background keeps
the options it was started with, so `permissionMode` only applies to sessions that never
ran in the background.

## Role context (optional)

You can give every chat Do-It drives a standing role or other context of your own, without
changing the chats you open yourself.

How it works: Do-It keeps a list of the turns it is driving, in `driving/` inside its
state folder (`~/.local/state/do-it`, or `DO_IT_STATE_DIR`). It adds a chat it continues
just before sending the message. A new chat is added as soon as `claude --bg` reports the
chat's id, because Claude Code picks that id itself. `hooks/role-context.mjs` is a Claude
Code `UserPromptSubmit` hook. When a prompt's session is on the list, the hook reads your
role file, adds its text to that prompt as `additionalContext`, and takes the session off
the list. Any other prompt gets nothing, including a chat you open yourself and anything you
type later into a chat Do-It started. A missing or empty role file, or a missing or broken
list, also means nothing is added. The hook never fails a prompt: on any problem it adds
nothing and lets the prompt through.

A new chat's first prompt can reach the hook a moment before Do-It has read the chat's id.
So while Do-It is starting or continuing a chat, a prompt from a chat that isn't on the list
waits up to five seconds for it to appear. Outside that window, the hook answers at once.

Leftovers can't pile up. Do-It takes a chat off the list when it stops it or the chat fails
to start. Entries older than ten minutes are ignored and pruned, and the list is cleared
whenever Do-It starts.

1. **Write your role file** at `~/.config/do-it/role.md` (or `role.md` in `DO_IT_CONFIG_DIR`
   if you set that). It is plain text; `examples/role.example.md` is a placeholder to start
   from. Keep it outside the repo: it's yours, not part of Do-It.

2. **Turn the hook on** in your user settings, `~/.claude/settings.json`, using the absolute
   path to your Do-It clone. Merge it into any `hooks` you already have:

   ```json
   {
     "hooks": {
       "UserPromptSubmit": [
         { "hooks": [{ "type": "command", "command": "node /home/you/do-it/hooks/role-context.mjs" }] }
       ]
     }
   }
   ```

3. **Optional: use a different file.** Put its absolute path after the script name:

   ```json
   "command": "node /home/you/do-it/hooks/role-context.mjs /home/you/notes/do-it-role.md"
   ```

The hook is plain Node.js with no dependencies or shell scripting, so the same setup works
on Linux, macOS and Windows. On Windows, write paths with forward slashes or escaped
backslashes in JSON, for example `"node C:/Users/you/do-it/hooks/role-context.mjs"`. If
`node` isn't on the `PATH` Claude Code sees, use the full path to `node`.

Changes to the role file apply from the next prompt, with no restart needed. To turn the
hook off, remove it from `settings.json`.

If you run Do-It with `DO_IT_STATE_DIR` or `DO_IT_CONFIG_DIR` set, the hook needs the same
values. Set them in the `env` block of the same `settings.json`. Do-It's own environment
doesn't reach Claude Code's background sessions.

## Known limits

- **No sending into an open window.** Claude Code can't take a message into a session that
  is open in an interactive window (the desktop app, a terminal, or Remote Control).
  `send_message` refuses those and says so: close the session there and send again, or
  start a new one. `stop_session` also can't stop them.
- **Sending stops first.** For a running background session, `send_message` stops it and
  resumes it with your message. Interrupting a busy session therefore ends its current
  turn.
- **Undocumented CLI output.** Do-It relies on what `claude agents --json` and
  `claude --bg` print. A Claude Code update that changes that output can break it.
- **One owner.** There are no per-user permissions: every allowed GitHub login can do
  everything.
- **Restarting the service also stops its sessions.** Background sessions the service
  started stop with it, and that includes any Claude session that asked for the restart.

## Platforms

- **Linux:** supported. Run with systemd.
- **macOS:** supported. Run with launchd. The CI workflow runs the tests on macOS.
- **Windows: not yet supported.** The background-session commands Do-It depends on
  (`claude --bg`, `claude agents --json`, `claude stop`) haven't been checked on Windows.
  Two pieces are already in place: drive roots like `C:\` are refused as allowed roots,
  and an npm `claude.cmd` install is run without a shell, by finding the script or `.exe`
  the shim wraps. If that fails, set `DO_IT_CLAUDE_BIN` to `claude.exe` or to the CLI's
  `.js` file. `do-it install` would register a hidden Task Scheduler task that runs at
  logon and restarts on failure. Task Scheduler only restarts a task that fails to start, not
  one that exits later, so a crashed server stays down until the next logon. That path has
  only been tested against generated files, never on a real Windows machine. The optional role-context hook is plain Node.js and needs no changes there.

## Configuration reference

| Where | Setting |
|---|---|
| `~/.config/do-it/config.json` | `publicUrl` (required), `allowedRoots`, `allowBypassPermissions`. Templates are in `examples/`. `allowedRoots` and `allowBypassPermissions` reload automatically. |
| `~/.config/do-it/github.json` | `clientId`, `clientSecret`, `allowedLogins`. Reloads automatically: a login you remove loses access at its next request. |
| `~/.config/do-it/role.md` | Optional text for the [role-context hook](#role-context-optional). |
| `~/.local/state/do-it/driving/` | The turns Do-It is driving right now, for the role-context hook (managed by Do-It). |
| Environment | `DO_IT_PUBLIC_URL` overrides `publicUrl`. `DO_IT_PORT` (default 8787), `DO_IT_CONFIG_DIR`, `DO_IT_STATE_DIR` (default `~/.local/state/do-it`) and `DO_IT_CLAUDE_BIN` (path to `claude`) are also read. |

How sign-in works: Do-It is its own small OAuth 2.1 server, with dynamic client
registration, PKCE and rotating refresh tokens. It hands the identity check to GitHub and
issues tokens only to the logins in `allowedLogins`. Its signing key, registered clients and
refresh tokens are kept in `oauth.json` in the state folder (mode 600). To sign every client
out, stop the server, delete that file and start it again. If the file is damaged, the server
won't start and says so, rather than replacing it.

The server logs one line per HTTP request to stdout: method, path, status, client address,
user agent and MCP protocol headers. Query strings are never logged, because they carry
OAuth codes.

## Development

`npm test` runs offline. GitHub, the `claude` CLI and the Agent SDK are all faked, and
nothing reads or writes your real Claude Code files. The CI workflow runs it on Linux and macOS.

## License

MIT. See [LICENSE](LICENSE).

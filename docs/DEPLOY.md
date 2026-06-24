# Running Saoirse as an always-on supervised service

The daemon terminates on error (EADDRINUSE, fatal init failure) and exits cleanly
on SIGINT/SIGTERM. A supervisor that restarts on non-zero exit is what makes it
"always-on". This document covers both targets: **Linux (systemd)** for the
homelab fabric (Starbase / Tailscale nodes) and **Windows** for the dev machine.

---

## Prerequisites

**Build first.** The supervisor runs the compiled output, not `tsx`.

```bash
# Node 20 ONLY — Engram's native dep is ABI-matched to Node 20.
# If you have multiple Node versions, activate 20 before any npm call.
fnm use 20        # or: nvm use 20

npm install
npm run build     # output: dist/
```

Confirm the right Node is active: `node --version` must print `v20.x.x`.

**Populate `.env`** in the repo root before starting the supervisor. The daemon
loads `.env` from its **working directory** at startup — if the supervisor's
`WorkingDirectory` (Linux) or `Start In` (Windows) does not point at the repo
root, the file will not be found and all config falls back to defaults / missing
values. Minimum required:

```
SAOIRSE_TOKEN=<a secret string>
MODEL_ENDPOINT=http://<your-model-server>/v1
```

See `.env.example` for the full set (`PORT`, `MODEL_NAME`, `ENGRAM_DB`,
`ENGRAM_EMBEDDINGS`, `NATS_URL`, `PI_COMMAND`, etc.).

**Single instance only.** Engram's SQLite database is single-writer. Never run
two `saoirse-daemon` processes pointing at the same `ENGRAM_DB`. The daemon will
fail on the second start with an EADDRINUSE-like error from SQLite.

---

## Linux — systemd

Place the unit file at `/etc/systemd/system/saoirse.service`. Adjust the paths
and user to match your setup.

```ini
[Unit]
Description=Saoirse always-on AI core daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tom
Group=tom
WorkingDirectory=/home/tom/projects/saoirse

# Node 20 path — adjust if fnm/nvm installs elsewhere.
# Find yours with: fnm which 20  (or: which node  when Node 20 is active)
ExecStart=/home/tom/.fnm/node-versions/v20.19.2/installation/bin/node dist/index.js

# Restart on any non-zero exit (port conflict, fatal init, unhandled rejection).
Restart=always
RestartSec=5s

# Give the daemon time to drain in-flight requests before SIGKILL.
TimeoutStopSec=15s

# Environment from the .env file in WorkingDirectory is loaded by the daemon
# itself; secrets do not need to go in this unit. Shell-level overrides still win.
# If you need per-host overrides without editing .env, add them here:
# Environment="PORT=8787"

StandardOutput=journal
StandardError=journal
SyslogIdentifier=saoirse

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable saoirse
sudo systemctl start saoirse
sudo journalctl -u saoirse -f          # follow logs
```

The daemon's existing SIGTERM handler (`process.on('SIGTERM', shutdown)`) closes
the HTTP server, drains the NATS channel, and flushes Engram before exit.
systemd sends SIGTERM on `systemctl stop`; no extra plumbing needed.

**Graceful restart** (after `.env` edit, skill promotion, or Engram re-pin):

```bash
sudo systemctl restart saoirse
```

Promoted skills and a re-pinned Engram take effect only after a restart — the
running process never reloads them mid-flight.

---

## Windows — dev machine

Three options; **pm2 + pm2-windows-startup is the recommended path**.

### Option A — pm2 + pm2-windows-startup (recommended)

pm2 is a battle-tested Node process manager. `pm2-windows-startup` registers it
as a Windows service that starts at boot.

```powershell
# Install once (Node 20 shell):
npm install -g pm2 pm2-windows-startup

# Register pm2 itself as a Windows startup service:
pm2-startup install

# From the repo root (working directory must be the repo root for .env loading):
cd D:\projects\saoirse
pm2 start dist/index.js --name saoirse --restart-delay 5000

# Save the process list so pm2 restarts it after the Windows service starts at boot:
pm2 save
```

Useful commands:

```powershell
pm2 status                   # list managed processes
pm2 logs saoirse             # tail logs
pm2 restart saoirse          # graceful restart (SIGTERM then re-launch)
pm2 stop saoirse             # stop without removing from list
pm2 delete saoirse           # remove from pm2 entirely
```

pm2 restarts the process on non-zero exit with the configured delay. Logs are
written to `~/.pm2/logs/`.

**Node version caveat:** pm2 will use whichever `node` binary is on the system
PATH when `pm2-windows-startup` fires at boot. Pin it explicitly if your PATH
may resolve Node 24 at login:

```powershell
# Pass the full Node 20 binary path to pm2:
pm2 start dist/index.js --name saoirse --interpreter "C:\path\to\node20\node.exe" --restart-delay 5000
```

Find the path: in a Node 20 shell, run `where.exe node` (PowerShell) or
`which node` (Git Bash).

---

### Option B — NSSM (Non-Sucking Service Manager)

NSSM wraps any executable as a proper Windows service with automatic restart,
stdout/stderr capture, and a GUI editor. Good if you want a native Windows
service rather than a Node process manager.

```powershell
# Install NSSM (winget or download from nssm.cc):
winget install nssm

# Create the service (run as Administrator):
nssm install SaoirseDaemon "C:\path\to\node20\node.exe" "D:\projects\saoirse\dist\index.js"
nssm set SaoirseDaemon AppDirectory "D:\projects\saoirse"
nssm set SaoirseDaemon AppRestartDelay 5000
nssm set SaoirseDaemon AppStdout "D:\projects\saoirse\logs\saoirse.log"
nssm set SaoirseDaemon AppStderr "D:\projects\saoirse\logs\saoirse-err.log"
nssm set SaoirseDaemon Start SERVICE_AUTO_START

nssm start SaoirseDaemon
```

`AppDirectory` sets the working directory — required for `.env` loading.

---

### Option C — Task Scheduler

Usable but limited: Task Scheduler's "restart on failure" is coarse (fixed
retry count, not indefinite), and log capture requires an extra wrapper. Prefer
pm2 or NSSM. If you need it:

- Trigger: **At log on** (or At startup, requires SYSTEM account)
- Action: `node.exe`, argument `D:\projects\saoirse\dist\index.js`, Start in
  `D:\projects\saoirse`
- Settings: "If the task fails, restart every 30 seconds", "Attempt to restart
  up to 999 times"

---

## Health checks

Both supervisors should rely on process exit codes. Optionally, pair with an
external watchdog (UptimeKuma, healthchecks.io, or a NATS-side probe):

```bash
# HTTP liveness:
curl http://localhost:8787/health

# Richer status (model reachability, loaded skills, version):
curl http://localhost:8787/status
```

A `200` from `/health` means the daemon is up and the HTTP server is accepting
connections. `/status` adds model endpoint reachability and the loaded skill list.

---

## Operational notes

| Concern | Behaviour |
|---|---|
| Port conflict (EADDRINUSE) | Daemon logs the conflict and exits non-zero — supervisor restarts it. If the conflict is persistent, another Saoirse is running; stop it first. |
| SIGTERM / SIGINT | Handled: HTTP server closes, NATS drains, Engram flushes. Supervisor waits `TimeoutStopSec` (Linux) before SIGKILL. |
| `.env` edits | Not hot-reloaded. Restart the daemon (`systemctl restart` / `pm2 restart`). |
| Skill promotion | Takes effect only on next daemon start. Restart deliberately after `saoirse approve <id>`. |
| Engram re-pin | Approval rewrites `package.json` only. Run `npm install` (Node 20) then restart the daemon. |
| Multiple instances | Forbidden. One `ENGRAM_DB` → one writer. A second daemon will crash or corrupt. |
| Tailscale scope | The daemon listens on `localhost` by default. Tailscale exposes it to the mesh; no firewall hole needed. |

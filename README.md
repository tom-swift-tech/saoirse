# Saoirse

Always-on personal AI assistant. One persistent core service, reached through
multiple operational channels (mobile, web, CLI, TUI, voice).

- **Identity & governance:** see [SYSTEM.md](./SYSTEM.md)
- **Architecture:** see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

## Status

Core daemon stands up HTTP + WS (+ optional NATS) over Engram (pinned) + an
OpenAI-compatible model gateway. The full loop: utterance → recall → model call
→ (committed-skill calls)\* → reply → retain → out. Promoted skills load at
start and the model invokes them via standard OpenAI tool calling. Proven by
the vitest suite (faux gateway/memory, no live providers) and verified live
end-to-end against a local model endpoint.

```
cp .env.example .env          # set SAOIRSE_TOKEN; point MODEL_ENDPOINT at an OpenAI-compatible server
npm install                   # Node 20 ONLY — shares an ABI-sensitive native dep with Engram
npm test                      # 21 tests, green
npm run dev                   # or: npm run build && npm start
curl -X POST localhost:8787/message -d '{"text":"what'\''s new"}'
```

The daemon loads `.env` from its working directory at startup (`PORT`,
`MODEL_ENDPOINT`, `MODEL_NAME`, `SAOIRSE_TOKEN`, `ENGRAM_DB`, `ENGRAM_EMBEDDINGS`).
Variables already set in the shell override the file. Restart the daemon after
editing `.env`.

A production reply needs a reachable OpenAI-compatible endpoint at
`MODEL_ENDPOINT` (Herd, Ollama, llama-server, vLLM — all interchangeable); the
model call is otherwise stubbed behind `ModelGateway` (no cloud API). Engram's default
embedder downloads a local model on first use — to boot offline (no network, no
download) set `ENGRAM_EMBEDDINGS=offline`, which uses a deterministic dev
embedder so recall/retain run without a model. That is how the loop is
exercised end-to-end against real Engram/SQLite in the suite and via a running
daemon.

## Quick start — CLI

`saoirse` is the first channel: a thin client over the daemon's HTTP/WS API. It
imports nothing from the core — it only speaks the wire contract, so it talks to
the daemon over the network like any other spoke will.

**1. Build, and make the `saoirse` command available**

```
npm install && npm run build   # Node 20 only
npm link                        # exposes `saoirse` (client) and `saoirse-daemon` on your PATH
```

No PATH changes? Skip `npm link` and call the built entry directly —
`node dist/client/cli.js "what's new"` works the same everywhere below.

**2. Start the daemon** (in its own terminal; Ctrl+C to stop)

```
saoirse-daemon                  # or: npm start  /  npm run dev
```

**3. Point the CLI at it and talk to her**

Set the environment, once per shell. `SAOIRSE_URL` defaults to
`http://localhost:8787` (use a Tailscale name for remote); `SAOIRSE_TOKEN` must
match the token the daemon was started with (needed for the push channel).

PowerShell:

```powershell
$env:SAOIRSE_URL  = "http://localhost:8787"
$env:SAOIRSE_TOKEN = "..."
```

bash / zsh:

```bash
export SAOIRSE_URL=http://localhost:8787
export SAOIRSE_TOKEN=...
```

Then talk to her (identical in both shells):

```
saoirse "what's new"        # one-shot: POST /message, print the reply
saoirse --json "hi"         # print the raw daemon response (agents read JSON)
saoirse                     # interactive REPL + WS push events (needs SAOIRSE_TOKEN)
"what's new" | saoirse      # one-shot from stdin
```

Note the stdin pipe differs per shell: PowerShell uses `"what's new" | saoirse`,
bash uses `echo "what's new" | saoirse`.

In the REPL, type `exit` (or Ctrl+C) to quit. Without `SAOIRSE_TOKEN` the CLI
warns and runs HTTP-only (no push channel). If the daemon isn't running you get
a plain `Saoirse core not reachable at <url>` — not a stack trace.

## Dashboard TUI

`saoirse-tui` is a persistent terminal dashboard (built on `@mariozechner/pi-tui`):
a scrolling conversation plus live **Model** (name + endpoint reachability),
**Memory** (memories recalled on the last turn), and **Proposals** (pending
pi-build queue) panes, a WS push-log, and a connection line. Same `SAOIRSE_URL` /
`SAOIRSE_TOKEN` env as the CLI; it's a thin client — zero core imports.

```
saoirse-tui                 # (or: node dist/client/tui.js)
```

Type to chat (Enter sends, full reply — no streaming). `/approve <id>` and
`/reject <id>` act on proposals from the input line (token-gated, fail-closed
without `SAOIRSE_TOKEN`). `exit` or Ctrl+C quits cleanly. It feeds two small
additive daemon endpoints: `GET /status` and a `recall: { count }` field on
`/message` (the `reply` field is unchanged for existing clients).

## Tool-building (Tier 1 — gated)

Saoirse can build tools on the fly via **pi**, but a built tool is **ACCRETED**,
not live: pi writes only into `PI_SANDBOX`, and the result is queued as a
proposal. Promotion into the live `skills/` directory is a separate, **token-gated**
human action — there is no code path from a build to a live capability without it
(SYSTEM.md Tier 1). Set `PI_COMMAND` to enable; leave it unset and `/build` returns 503.

The live wiring is `PI_COMMAND=node scripts/pi-build.mjs`: the adapter drives
the real [pi coding agent](https://github.com/badlogic/pi-mono)
(`npm i -g @earendil-works/pi-coding-agent`, Node 20) non-interactively in a
throwaway scratch directory and ships the files back as data — the daemon's
builder seam containment-checks every path before anything touches the
sandbox. pi talks to the same `MODEL_ENDPOINT` as the daemon, through a
generated per-build config (`PI_CODING_AGENT_DIR`), so `~/.pi` is never read
and no API cost is incurred. A build that produces an unloadable skill, fails
its spec test, or writes nothing is rejected before a proposal is queued.

```
saoirse build weather "fetch the weather for a city"   # accretes a sandboxed proposal
saoirse proposals                                       # list the pending queue
saoirse approve <id>                                    # promote -> skills/ (needs SAOIRSE_TOKEN)
saoirse reject  <id>                                    # discard the sandbox artifact
```

`build`, `approve`, and `reject` are privileged (require `SAOIRSE_TOKEN`).
Promoted tools load on the next daemon start — the running process is never
mutated by a build or an approval.

## Committed skills (how a promoted tool runs)

At daemon start, every directory under `skills/` holding a valid `skill.json`
is loaded and offered to the model as an OpenAI tool; when the model calls one,
the entry script runs as a short-lived subprocess (args as JSON on stdin,
stdout returned to the model), bounded by a timeout and a capped round count. A
broken manifest is reported and skipped — one bad skill never takes the daemon
down. The manifest contract a built artifact must satisfy:

```json
{
  "name": "clock",                       // must equal the directory name
  "description": "what the model sees",
  "entry": "run.mjs",                    // Node script, inside the skill dir
  "parameters": { "type": "object", "properties": {} },   // JSON Schema (optional)
  "timeoutMs": 10000                     // optional, default 30000
}
```

`GET /status` reports the loaded skills; `/message` responses carry a `tools`
telemetry field listing the skill calls made that turn. Approving a proposal
whose artifact won't load as a skill still promotes (it was human-approved) but
returns a `warning` instead of failing silently at next boot.

## East-west fabric (NATS)

Set `NATS_URL` (e.g. `nats://starbase:4222`) and the daemon joins the LAN
fabric, serving request/reply on `<NATS_PREFIX>.message` (default
`saoirse.message`): JSON `{"text": "..."}` in, `{"reply", "recall", "tools"}`
out. Agents and services only — human clients speak HTTP/WS. Leave `NATS_URL`
unset to stay off the fabric; an unreachable fabric is reported loudly and
never takes the north-facing channels down.

## Stack

- TypeScript / Node 20 (ABI-matched to Engram's native deps — see `.node-version`)
- Engram — memory, pinned git ref
- Model gateway — OpenAI-compatible endpoint (`MODEL_ENDPOINT`; Herd/Ollama/llama-server/vLLM)
- HTTP + WebSocket — north-facing channel contract
- NATS — east-west fabric (later)
- pi — the coding agent behind build-on-the-fly (`scripts/pi-build.mjs` adapter)

## Principles

Self-hosted over SaaS. Zero API cost where possible. Public repos as source of
truth. Being is human-gated; knowing is autonomous (see SYSTEM.md governance).

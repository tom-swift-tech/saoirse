# Saoirse — TODO

## Run-model gaps (from the "how it's intended to run" review, 2026-06-24)

Operational-edge gaps between "always-on reactive daemon" intent and what's in
the tree. Logic is sound; these are about staying up, telling the truth about
memory health, and the not-yet-live push plane.

- [ ] **Supervision for "always-on".** No systemd unit / pm2 config / restart
      policy is committed. `main().catch(process.exit(1))` and the `EADDRINUSE`
      guard both terminate the process with nothing to bring it back after a
      crash or reboot. Add a committed service unit + restart policy and document
      the always-on deploy. *(biggest intent↔tree gap)*

- [ ] **Embedder health is silent — close the Tier-0-shaped footgun.** In
      `ollama` mode, embeddings target Engram's own URL (`localhost:11434`)
      independent of `MODEL_ENDPOINT` (`.env.example:40`). If Ollama isn't
      co-located, chat works while embeddings silently fail and recall quietly
      degrades — no error tripped. Add an embedder health probe to `GET /status`
      and the boot banner (mirror the existing `probeReachable` for chat). The
      governance gates protect the memory *engine source*; nothing yet protects
      the running *embedding pipeline's* health.

- [ ] **WS push plane is still a skeleton.** `/ws` only sends hello + heartbeat +
      echo; the TUI gets status via HTTP polling. "The core pushes (ambient
      updates, dashboard waking)" is architecture, not yet behavior — the async
      half of the design carries no real events. Wire real push events
      (e.g. proposal-queued, status-changed) through the WS channel.

- [ ] **`.env` loads only from cwd.** `loadDotenv()` reads `.env` from the
      current working directory; launching `saoirse-daemon` from elsewhere
      silently loads no `.env` and falls back to defaults — a quiet
      misconfiguration vector for an always-on service. Resolve `.env` relative
      to the daemon's package root (or log loudly when no `.env` was found).

## Capabilities (the shelf is bare — only `clock` is committed)

The factory for capabilities exists (skills + pi-build + governance gates); the
capabilities themselves don't. Two missing PRIMITIVES gate most useful skills —
build those first, then individual skills are cheap. Ordered by build sequence.

### Primitives (foundational — unblock whole tiers)

- [ ] **P1 — Skill credential / permission model.** `skill-runner.ts` strips the
      daemon's secrets from every skill (correct), so there is NO sanctioned way
      for a skill to authenticate. Blocks all of Tier B/C/D below. This is
      GOVERNANCE.md Open Question 1. **Design drafted:**
      [docs/design/skill-permissions.md](../docs/design/skill-permissions.md).

- [ ] **P2 — Outbound channel + scheduler (proactivity).** She is purely
      reactive and the WS push plane is a skeleton, so she cannot initiate:
      no reminders, no notifications, no "I noticed X". For an *always-on*
      assistant this is the biggest single missing capability. (Overlaps the
      run-model gaps above: WS push + no scheduler.) Self-hosted notify target:
      ntfy or Matrix, not Twilio.

### Tier A — read the world (no primitive needed; build now)

- [ ] **Web search** — without it she's frozen at training cutoff + memory. The
      #1 gap. Skill → self-hosted **SearXNG** (not a paid search API).
- [ ] **Web fetch + read** — search returns links; she must read them. Skill →
      fetch + Readability/trafilatura extraction.
- [ ] **Browser automation** — JS-heavy sites, logins, multi-step actions. Skill
      → Playwright headless. *Higher blast radius* (acts as the user) — needs P1.

### Tier B — act in the user's life (blocked on P1)

- [ ] **Notify / message the user** — the outbound half (rides on P2).
- [ ] **Email** (read/send) — IMAP/SMTP.
- [ ] **Calendar** (read/create) — CalDAV.
- [ ] **Files / notes** (scoped read/write of the user's docs & KB).

### Tier C — homelab integration (this user)

- [ ] **Roster delegation** — she *serves* NATS but never *calls out*; make her a
      NATS client to Mira/Gage/Zeke, not just a server.
- [ ] **n8n triggers** — fire existing automations via webhook.
- [ ] **Infra control** (Proxmox/Docker/Ansible) — *high blast radius*, strong
      governance required.

### Tier D — computer-use

- [ ] **Sandboxed code/shell execution** — pi can *build* skills but Saoirse
      can't *run* arbitrary code as a capability. The canonical P1 case.

### Tier E — multimodal (roadmapped last)

- [ ] **Vision / PDF / OCR**, then **voice (STT/TTS)** — local Whisper/Piper to
      honor self-hosted / zero-API.

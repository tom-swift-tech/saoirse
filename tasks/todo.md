# Saoirse — TODO

## Run-model gaps (from the "how it's intended to run" review, 2026-06-24)

Operational-edge gaps between "always-on reactive daemon" intent and what's in
the tree. Logic is sound; these are about staying up, telling the truth about
memory health, and the not-yet-live push plane.

- [x] **Supervision for "always-on".** ~~No systemd unit / pm2 config / restart
      policy is committed.~~ DONE (787f350) — `docs/DEPLOY.md` documents systemd
      (Restart=always) + Windows (pm2/NSSM/Task Scheduler) supervision with a
      sample unit. Actually installing the unit on a host remains an ops action.

- [x] **Embedder health is silent — close the Tier-0-shaped footgun.** DONE
      (787f350) — `probeEmbeddingsReachable` added; `GET /status` now carries
      `embeddings: { mode, reachable }` and the boot banner shows the embeddings
      target. `ENGRAM_EMBEDDINGS_URL` config (default localhost:11434), probed
      only in `ollama` mode, run concurrently with the model probe.

- [x] **WS push plane is still a skeleton.** DONE (3c2bd68) — a
      transport-agnostic core event bus (`core/events.ts`) now drives real WS
      push: `proposal.queued` (emitted by the core) and `proposal.resolved`
      (emitted by the approve/reject routes) are broadcast as JSON to every
      authed client; the TUI re-fetches `/proposals` on receipt (polling kept as
      fallback). All four run-model gaps are now closed.

- [x] **`.env` loads only from cwd.** DONE (787f350) — `loadDotenv()` now
      resolves `.env` from the package root (via `import.meta.url`) regardless of
      cwd, and logs loudly to stderr when no `.env` is found.

## Capabilities (the shelf is bare — only `clock` is committed)

The factory for capabilities exists (skills + pi-build + governance gates); the
capabilities themselves don't. Two missing PRIMITIVES gate most useful skills —
build those first, then individual skills are cheap. Ordered by build sequence.

### Primitives (foundational — unblock whole tiers)

- [~] **P1 — Skill credential / permission model.** Phase 1 DONE (9fe41de) —
      manifest `permissions` block (secrets/env/net/fs/exec, default-deny);
      env-prefix secret store (`SAOIRSE_SECRET_*`) captured + scrubbed at boot
      and injected per-declaration; fs/exec sandboxed via Node permissions;
      `/status` audits granted names + scopes. **Tier B/C/D are now unblocked.**
      Remaining phases (deferred, per
      [docs/design/skill-permissions.md](../docs/design/skill-permissions.md)):
      Phase 2 = `net` egress enforcement (generalize the webfetch SSRF guard);
      Phase 3 = per-invocation confirmation for high-blast-radius skills (on the
      WS channel).

- [~] **P2 — Outbound channel + scheduler (proactivity).** Phase 1 DONE
      (54549a1) — a persistent job store + 60s scheduler fires one-shot (`at`)
      and recurring (`cron`) jobs; actions `notify` (literal) or `prompt` (run
      through the core); delivered via a Notifier seam (ntfy first, `NTFY_URL`;
      `NullNotifier` fallback). Token-gated `/jobs` CRUD. **She can now
      initiate.** Later: recurring digests once authenticated skills exist, WS
      `job.fired` events, and the link to P1 Phase 3 confirmation for
      high-blast-radius scheduled actions. Matrix notifier is a future seam impl.

### Tier A — read the world (no primitive needed; build now)

- [x] **Web search** — DONE (d9d161c) — `skills/websearch` over self-hosted
      SearXNG (`SEARXNG_URL`), offered to the model as a tool. Her first
      read-the-world capability.
- [x] **Web fetch + read** — DONE (5f9ae42) — `skills/webfetch` fetches an
      http/https URL and returns readable text via a zero-dep extractor
      (`extract.mjs`). Pairs with websearch. No config needed.
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

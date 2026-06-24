# Design draft — Skill Credential / Permission Model (Primitive 1)

> Status: DRAFT for review. Concrete proposal for [GOVERNANCE.md](../GOVERNANCE.md)
> Open Question 1 ("a runtime capability/permission model — *what* may promoted
> code do?"). Nothing here is built yet.

## Problem

A committed skill runs as a subprocess via `ProcessSkillRunner`
(`src/core/skill-runner.ts`). The runner deliberately withholds the daemon's
secrets — `SAFE_ENV_KEYS` is a deny-by-default allowlist, and `SAOIRSE_TOKEN`,
`MODEL_ENDPOINT`, `NATS_URL` are explicitly NOT inherited. That is the correct
safety default, and it should stay.

But the consequence is: **there is no sanctioned way for a skill to authenticate
to anything.** Email, calendar, GitHub, any API skill has nowhere to obtain a
credential except a blanket `allowEnv` grant wired into the daemon — which leaks
the *daemon's whole* env value for that key to the skill, with no per-skill
scoping and no record of what was granted. This blocks the entire "act in the
user's life" capability tier (TODO Tier B/C/D).

The gate today answers **"may this skill EXIST?"** It does not answer **"what may
this skill REACH once it runs?"** Primitive 1 adds the second question — without
weakening the first.

## Principles (inherited, non-negotiable)

1. **Default-deny.** A skill with no permission declaration gets exactly today's
   baseline: `SAFE_ENV_KEYS`, no secrets, no extra reach. `clock` keeps working
   unchanged.
2. **Declared, not ambient.** A skill receives *only* what its manifest declares
   AND a human approved. Inheriting is drift; granting is deliberate
   (the existing `skill-runner.ts` comment, generalized).
3. **The grant is the approval.** A permission request travels inside the
   proposal diff. Granting permission and approving the skill are the same
   token-gated act — so privilege escalation is *visible at the gate*, never
   silent. A skill asking for `secrets` or broad fs/net is a louder approval.
4. **Fail closed and loud.** A declared secret that the store can't supply, or an
   unknown/malformed permission, fails at load — the skill is skipped and
   reported, never silently half-privileged (consistent with the existing bad-
   manifest posture).
5. **Honesty about enforcement strength.** Where a resource cannot be hard-
   enforced yet (network), say so in the doc and the banner rather than implying
   a guarantee that isn't there. Silent over-trust is the project's named enemy.

## Manifest extension

Add an optional `permissions` block to `skill.json`. Absent ⇒ default-deny
baseline (backward compatible).

```json
{
  "name": "gmail",
  "description": "Read and send mail on Tom's account.",
  "entry": "run.mjs",
  "parameters": { "type": "object", "properties": {} },
  "timeoutMs": 30000,

  "permissions": {
    "secrets": ["GMAIL_APP_PASSWORD"],
    "env":     ["HTTPS_PROXY"],
    "net":     ["imap.gmail.com", "smtp.gmail.com"],
    "fs":      { "read": ["~/mail/templates"], "write": [] },
    "exec":    false
  }
}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `secrets` | Logical secret names resolved from the credential store and injected into the child env under the bare name. | `[]` |
| `env` | Non-secret pass-through env keys beyond `SAFE_ENV_KEYS`. | `[]` |
| `net` | Egress host allowlist (exact host or `*.suffix`). | `[]` (deny) |
| `fs.read` / `fs.write` | Path scopes the skill may read / write, beyond its own dir + temp. `~` expands to the daemon user's home. | `[]` |
| `exec` | May the skill spawn child processes? | `false` |

## The credential store

Secrets must live somewhere the daemon can read but skills cannot enumerate.
**Recommended (phase 1): env-prefix store**, consistent with "all config from
env, no secrets in source", and `.env` is already gitignored:

```
# .env (daemon only, gitignored)
SAOIRSE_SECRET_GMAIL_APP_PASSWORD=xxxx
SAOIRSE_SECRET_GITHUB_TOKEN=ghp_xxxx
```

- A manifest declaring `"secrets": ["GMAIL_APP_PASSWORD"]` causes the runner to
  look up `SAOIRSE_SECRET_GMAIL_APP_PASSWORD` and inject it into the child as
  `GMAIL_APP_PASSWORD` (bare name) — and nothing else.
- The `SAOIRSE_SECRET_*` keys themselves are never inherited by any skill (they
  join the deny set), so a skill cannot read a secret it did not declare.
- A declared secret with no matching `SAOIRSE_SECRET_*` value ⇒ load fails loudly
  (fail closed) — the skill is skipped and reported, not run un-credentialed.

A separate JSON vault file is a possible later refinement (cleaner for many
secrets); the env-prefix store is chosen first for zero new format and one
obvious lookup rule.

## Enforcement — what's strong, what's honest

| Resource | Mechanism | Strength | Phase |
| --- | --- | --- | --- |
| **Secrets / env** | Runner builds the child env from baseline + declared `env` + resolved `secrets`; everything else withheld. | **Hard** — the runner fully controls the child env (it already does). | 1 |
| **Filesystem** | Node's permission model: spawn the entry with `--permission --allow-fs-read=<dir,temp,fs.read> --allow-fs-write=<dir,fs.write>`. | **Hard-ish** — real, but the flag is experimental and ABI/flag-sensitive (Node-20 constraint). Validate before relying on it. | 2 |
| **Child processes** | `exec:false` ⇒ omit `--allow-child-process` under `--permission` (denied by default). | **Hard** (same experimental caveat). | 2 |
| **Network egress** | **Not coverable by Node's permission model.** Inject `HTTP_PROXY`/`HTTPS_PROXY` pointing at a daemon-run local proxy that enforces the `net` allowlist. | **Soft until the proxy exists.** Phase 1 = *declared for human review only, no runtime enforcement*. Say so loudly. | 1 declare / 3 enforce |

`★ The honest edge:` network is the weakest link and the most-wanted by skills
(every API call). Phase 1 ships `net` as a **reviewed declaration** — the human
sees which hosts a skill wants at the gate — with no runtime block yet. Phase 3
adds the egress proxy. Do not let the manifest field imply enforcement that isn't
running; the boot banner should mark net enforcement `declared (not enforced)`
until the proxy lands.

## Code touch-points

- **`src/core/skills.ts`** — extend `LoadedSkill` with `permissions?:
  SkillPermissions`; parse + validate the block in `loadSkill` (unknown keys,
  malformed host globs, non-array fields ⇒ throw, i.e. skip + report).
  `validateSkillDir` already calls `loadSkill`, so **promotion-time validation is
  free** — a bad permission block warns at approve, same as a bad manifest.
- **`src/core/skill-runner.ts`** — replace the static `allowEnv` default with
  per-skill resolution: `buildSkillEnv(baseline, skill.permissions, store)`;
  resolve secrets from the store; assemble the Node permission flags from
  `fs`/`exec`; set proxy env from `net` (phase 3). `SAOIRSE_SECRET_*` joins the
  deny set.
- **`src/index.ts`** — load the credential store at boot; report per-skill
  granted scopes in the startup banner (e.g. `skills: gmail [secrets:1 net:2(declared)]`).
- **pi adapters** (`scripts/pi-build.mjs`) — pi may *request* permissions in the
  manifest it authors, prompted to request the MINIMUM; the human tightens or
  rejects at the gate. pi never grants — it only asks.

## Governance integration

- The `permissions` block is part of the proposal diff `approveProposal`
  promotes. **Approval = grant.** No separate ledger needed for phase 1: the
  promoted manifest IS the approved artifact, and `skills/` is written only by
  the gate.
- Defense-in-depth subtlety: a running skill must not be able to rewrite its own
  `skill.json` to escalate on next load. Phase 2 fs-scoping (default: no write to
  its own dir) closes this; until then it's bounded by the skill being human-
  approved code in the first place.
- A re-approval is required to widen permissions: editing a promoted skill's
  permissions means a new proposal through the same gate.

## Phasing

1. **Phase 1 — secrets + env + fs + exec (all hard) + full manifest schema +
   governance.** Unblocks email/calendar/API skills immediately. fs/exec are
   included here (not deferred) because the spike confirmed Node's permission
   model enforces them on the pinned Node 20. `net` is accepted and shown for
   review but enforced only as a declaration this phase.
2. **Phase 2 — network egress enforcement** by generalizing the `webfetch`
   SSRF guard (`skills/webfetch/ssrf-guard.mjs`) into a per-skill `net` allowlist
   / forward proxy; flip the banner from `declared` to `enforced`.
3. **Phase 3 (deferred) — per-invocation confirmation** ("Tier 1.5") for the
   first high-blast-radius skill (send-email, infra, code-exec): a runtime pause
   that pushes a confirmation event over the WS channel and waits for a token.

## Decisions (locked 2026-06-24)

1. **Store form → env-prefix, scrubbed at boot.** `SAOIRSE_SECRET_<NAME>` is read
   from the daemon env at boot, captured into a private in-memory map, then
   **deleted from `process.env`** so secrets don't linger in the live process env
   or get inherited by accident. A manifest's `secrets:["X"]` injects the bare
   `X` into that one skill's subprocess. A vault file is revisited only if secret
   count / rotation tooling grows.
2. **Grant granularity → per-skill manifest grants now.** Approval-at-promotion
   grants the manifest's declared scopes; every call uses them silently. Per-
   invocation confirmation is deferred to Phase 3 (above), built when the first
   high-blast-radius skill lands — reusing the WS push channel for the prompt.
3. **Auditability → `/status` lists granted secret *names* (never values) and
   scopes per skill.** Rotation requires a restart (consistent with the
   no-hot-reload rule; promotions and re-pins already work this way).

## Resolved by spike

1. **Node permission model viability** — RESOLVED by spike (Node 20.20.2,
   `--experimental-permission`). Phase 2 (fs + exec enforcement) is **viable**:
   - `--allow-fs-read=<path>` / `--allow-fs-write=<path>`: reads/writes outside
     the allowlisted paths fail with `ERR_ACCESS_DENIED`; inside paths succeed.
     **Implementation gotcha:** the entry script's own path (and any node_modules
     it imports) MUST be included in `--allow-fs-read`, or Node can't even load
     the module (`ERR_ACCESS_DENIED` in the loader). So the runner must always
     allowlist the skill's own dir + temp, then add the declared `fs.read` /
     `fs.write` scopes on top.
   - child_process is **denied by default** under `--experimental-permission`;
     `spawn` fails `ERR_ACCESS_DENIED` unless `--allow-child-process` is passed —
     so `exec:false` is the natural default and `exec:true` opts in.
   - **Network is NOT covered** (no network flag in Node 20): an outbound connect
     is attempted normally — confirming `net` enforcement needs the Phase 2
     egress work (generalize the webfetch SSRF guard), not the permission model.
   Caveat: it prints an `ExperimentalWarning` (cosmetic) and is experimental, so
   pin behavior to the Node-20 version and re-verify on any Node bump.

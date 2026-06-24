# Saoirse — Placing a New Capability

> Companion to [SYSTEM.md](../SYSTEM.md). SYSTEM.md defines *what the tiers are*;
> this defines *how to place a new capability into them* — and where a capability
> does NOT belong in the gate at all. Read SYSTEM.md's Governance section first;
> this is the operational decision procedure that hangs off it.

The spine is unchanged: **does the change alter what she IS, or what she KNOWS?
Knowing is autonomous; being is human-gated.** What this document adds is a
repeatable way to answer that question for anything new — a plugin, a skill, a
channel, a fabric, a model backend — without re-litigating the principle each
time.

## Rigor is proportional, not uniform

The amount of ceremony a capability earns is **blast radius × silent-failure
risk**, not a flat "gate everything" rule. Applying the proposal gate to a thing
with no blast radius (a thin channel) is miscalibrated rigor — ceremony with
nothing to justify it, which reads as a smell, not a virtue. The tiers exist
precisely so that the heavy machinery lands only where a mistake is both
consequential AND quiet.

The highest gate is reserved for the quiet failures. A crash screams; corrupted
memory whispers. That asymmetry is why Tier 0 (the memory engine) carries more
ceremony than anything else, including a defense that exists specifically to
catch *silent* degradation (the baseline-test floor — see below).

## The decision procedure

Ask these in order. The first one that matches places the capability.

```
Q1. Can Saoirse reach it autonomously at all?
    NO  → ordinary human SDLC. No proposal gate. The rigor that applies is
          CONTRACT discipline + review + auth — not Tier ceremony.
          (core internals, model gateway, a channel's own code)
    YES → continue.

Q2. Does it change the running SUBSTRATE whose failures are silent (memory)?
    YES → TIER 0. Highest gate: sandbox clone → Engram's own suite → the
          acceptance predicate → written proposal → token-gated re-pin →
          deliberate `npm install` + restart. Never mutate the live source.

Q3. Does it add an invokable CAPABILITY that runs at arm's length
    (a subprocess or a contract, never in-process)?
    YES → TIER 1. Medium gate: build into a sandbox → ACCRETE a proposal →
          token-gated promotion into skills/ → loads on next start.

Q4. Is it just knowledge / working notes?
    YES → TIER 2. Autonomous. The trust/provenance layer governs it; no gate.

Q5. Does it run IN-PROCESS with reach into the trusted core?
    → STOP. This tier is not designed. The current architecture's standing
      answer is NO: extension happens at arm's length (subprocess or contract),
      never inside the core. Refactor it to Q3 shape, or make a deliberate,
      written decision to design a new tier (see Open Questions).
```

## The reusable seam template

A capability that lands in Tier 0 or Tier 1 should be built to the *same shape*
the existing two use — this is not a coincidence to be reinvented but a template
to be copied. `engram-evaluator.ts` and `engram-author.ts` both say, in so many
words, "mirrors the ToolBuilder seam." A new gated capability inherits the
safety for free by matching it:

1. **An interface the core depends on** (`ToolBuilder`, `EngramEvaluator`,
   `EngramAuthor`). The core knows the seam, never the implementation.
2. **One configured concrete impl** that is the *only* thing shelling out / doing
   the dangerous work. Wired in `index.ts`, disabled by default (a missing env
   var = the feature is off, loudly).
3. **All work in a sandbox** under a root, with `resolveInside`/`isInside`
   (`core/sandbox.ts`) guarding every caller-supplied path. The capable component
   writes only there.
4. **One acceptance gate**, shared. Tier 0 reuses `isEngramCandidateAcceptable`
   for both evaluate and author. A new capability supplies *evidence of the same
   strength*, not just the same workflow (see Open Question 2).
5. **ACCRETE, never promote.** The build/eval path writes a pending proposal and
   nothing else. There is exactly one promotion writer per tier
   (`approveProposal` for skills/, `approveEngramProposal` for the pin), each
   reachable from exactly one token-gated route.
6. **No mutation of the running process.** A promotion takes effect on the next
   deliberate start, never mid-session.

If a proposed capability can't be expressed in this shape, that is itself the
signal that it belongs in Q1 (human SDLC) or Q5 (undesigned) — not that the
template should be bent.

## Worked placements (precedent)

| Capability | Placement | Why | Status |
| --- | --- | --- | --- |
| Skills / tools | Tier 1 | An invokable capability that runs as a bounded subprocess at arm's length | Built |
| Engram (memory engine) | Tier 0 | The running substrate; its failures are silent | Built (publish deferred) |
| Channels (mobile, web, voice, TUI) | **Not gated** (Q1) | A thin client that holds no logic and imports nothing from the core has no blast radius — the rigor it needs is contract discipline + auth, not a proposal gate | Partially built |
| NATS east-west fabric | Q1 / contract | A transport the core speaks; trust assumption is "agents/services only," enforced by the network boundary | Built (faux-verified) |
| Core internals / model gateway | Q1 (human SDLC) | "What she IS," but with no autonomous path to reach it — so plain review, no automated gate | N/A |
| Plugins (in-process, core access) | **Q5 — undesigned** | Blast radius is closer to Tier 0 than Tier 1; forces a decision rather than a default | Not designed |

## What the gates do and don't cover today

Stated plainly so the next capability inherits accurate expectations, not
optimistic ones:

- **Existence is gated; runtime authority is partially fenced.** Promotion
  decides *whether* a skill exists. Once running, a skill is a Node subprocess —
  and `skill-runner.ts` already withholds the daemon's secrets by a
  deny-by-default env allowlist (`SAFE_ENV_KEYS`): `SAOIRSE_TOKEN`,
  `MODEL_ENDPOINT`, `NATS_URL` etc. are NOT inherited; a skill that legitimately
  needs more is granted it explicitly (`allowEnv`). What is NOT yet fenced is
  **network and filesystem reach** — a running skill has the process's ambient
  access to both. That is the open edge as capabilities grow toward touching
  external systems (Open Question 1).
- **The gate is only as strong as the evidence supplied.** Engram clears a
  334-test floor — a strong gate. A Tier-1 skill's spec test is *optional*
  (`ToolSpec.test?`), and pi's guardrails ("don't weaken tests") are *requested
  in a prompt*, enforced only downstream by whatever test exists. Strong gate for
  memory; soft gate for a novel skill with no test (Open Question 2).
- **pi is the untrusted-but-capable component, fenced by structure.** It edits a
  throwaway clone and commits nothing; the trusted daemon owns git, the diff, the
  tests, and the gate. Generalize the *division of labor*, not just the workflow:
  the capable thing never holds the keys.

## Open design questions (decide before "more" arrives)

These are deliberately unanswered. They are the two decisions that the next wave
of capabilities will force; making them on purpose now beats discovering them
under pressure.

**1. A runtime capability/permission model — *what* may promoted code do?**
Today Tier 1 fences secrets (env allowlist) but not network or filesystem. A
skill that reaches credentials, money, or external systems makes "a human
approved that it exists" stop being the same as "this is safe to run on every
call." The decision: do promoted capabilities get a declared, enforced
permission set (network hosts, fs paths, granted env) — a manifest the runner
enforces — or does arm's-length subprocessing remain the whole story? A concrete
proposal — manifest schema, credential store, and per-resource enforcement with
honest strength notes — is drafted in
[docs/design/skill-permissions.md](./design/skill-permissions.md).

**2. Evidence strength — *how well* must a gated capability prove itself?**
The acceptance gate is uniform in *shape* but not in *strength*: Engram's 334
tests vs. a skill's optional spec test. The decision: should Tier 1 require a
non-trivial passing test as a promotion precondition (raising the floor toward
Tier 0's), or is human approval the intended backstop for thinly-tested skills?

**3. In-process extension — is Q5 ever allowed?** The architecture currently
votes no by omission: skills are subprocesses, pi commits nothing, channels
import nothing — extension is always at arm's length. The decision: ratify that
as an explicit rule (in-process plugins are disallowed; everything is a
subprocess or a contract), or design the missing tier for in-process reach with
the ceremony its Tier-0-adjacent blast radius would demand.

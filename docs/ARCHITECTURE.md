# Saoirse — Architecture

## One core, many spokes

```
                    ┌─────────────────────────────┐
                    │   SAOIRSE CORE (daemon)     │  always-on, the "her"
                    │   - session/conversation    │
                    │   - intent routing          │
                    │   - Engram (memory, pinned) │
                    │   - model gateway (OpenAI)  │
                    │   - tool/skill execution    │
                    │   - pi invoked as a tool     │
                    │     (build-on-the-fly)       │
                    └──────────────┬──────────────┘
                                   │  HTTP + WS (the contract)
        ┌──────────────┬───────────┼───────────┬──────────────┐
      mobile          web          cli         tui          voice
      (spoke)        (spoke)      (spoke)      (spoke)      (wake+STT)
                                   │
                            ┌──────┴──────┐
                            │  NATS (LAN) │  east-west: roster, n8n
                            └─────────────┘
```

## The keystone

The core is a service with ONE API. Every interface is a thin client over it.
Channels render and capture; they hold no logic. Get this boundary right and a
sixth channel is a weekend, not a rewrite.

## Transport split

- **HTTP** — client initiates and waits. "What's new", commands, anything
  synchronous/turn-based.
- **WebSocket** — core pushes. Ambient updates, the dashboard waking, streaming
  tokens to voice/TUI as they generate. Auth token on connect.

If the client asks and waits → HTTP. If the core reaches out or streams → WS.

## Two planes

- North-facing (HTTP/WS): humans and their devices. Reachable beyond LAN via
  Tailscale. This is where auth matters.
- East-west (NATS): agents and services, all local. Saoirse core ↔ existing
  roster, n8n, homelab. Don't make human clients speak NATS; don't pay a bridge
  tax for purity not needed.

## Naming & addressing

Saoirse references capabilities and contracts, never products or hosts.

- Model layer: an OpenAI-compatible endpoint at `MODEL_ENDPOINT`. Herd, Ollama,
  llama-server, and vLLM are interchangeable config values, not names in source.
- External addresses are Tailscale MagicDNS names via env, never IPs or LAN
  hostnames in source or committed config.
- Target the common `/v1/chat/completions` contract; treat any provider-specific
  extensions as optional config, never assumptions in the core path.

## Build order

1. [DONE] Engram CLI — memory, green, hand-verified.
2. Core daemon skeleton — HTTP + WS + Engram + model gateway + one echo-loop
   handler. Prove: utterance in → recall → model call → respond → retain → out.
3. [DONE] CLI/TUI spoke (`saoirse`) — cheapest channel, validates the API
   contract first. Thin client over HTTP/WS; imports nothing from the core.
4. [DONE] pi-as-tool — build-on-the-fly behind the Tier-1 gate. A build is
   ACCRETED into a sandbox and queued as a proposal; promotion into live
   `skills/` is a separate, token-gated action. No build→live path exists.
   Live: `PI_COMMAND=node scripts/pi-build.mjs` adapts the real pi coding
   agent to the builder contract, against the same MODEL_ENDPOINT.
5. [DONE] Skill execution — committed skills load at start (skill.json
   manifest), are offered to the model as OpenAI tools, and run as bounded
   subprocesses. Closes the Tier-1 loop: build → propose → approve → usable.
6. [DONE] NATS east-west listener — optional (NATS_URL), request/reply on
   `saoirse.message` over the same core; agents/services only. Verified against
   a faux connection; live fabric pending a reachable NATS server.
7. Voice + dashboard hardware — hardware-gated, last. Nothing above depends on
   it. (The TUI dashboard spoke already exists; this is wake word/STT/TTS.)

## Milestone for the skeleton (step 2)

A daemon you can hit with:
```
curl -X POST localhost:PORT/message -d '{"text":"what'\''s new"}'
```
and get back a real model-generated, Engram-informed answer. No voice, no
dashboard, no mobile. Just the loop, breathing.

---
name: codont
description: Start and evolve this session's Code Ontology — a user-driven, server-verified call-graph diagram (Go) that lives in devboard and that YOU, the session's own agent, build from this terminal over HTTP. Use when the user runs `run /codont <entry point or data-flow instruction>`, and re-read it whenever they ask to add/remove/change something in the diagram.
---

# Code Ontology (Codex)

The user types `run /codont <instruction>` into this Codex session. The procedure is agent-neutral
and lives in **`~/.agents/specs/codont-agent.md`**. Read it in full now, together with
`~/.agents/specs/codont.md` (the contract) and `~/.agents/codont/meta/go.md` (what boxes, badges
and edges mean in Go), then carry out the instruction exactly as it says.

Codex-specific notes:
- Use the shell for everything (`curl`, `git`, `bash`); the procedure needs nothing else.
- Session id: use this Codex session's id (from your runtime context, or the UUID at the end of
  this session's rollout file under `~/.codex/sessions/`). If you cannot determine it reliably,
  ask the user.

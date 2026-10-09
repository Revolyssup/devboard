---
name: start-env
description: Spin up (or reuse) a composed environment for this session from a natural-language instruction or a ticket/issue URL — picks the recipe and params, shows devboard's plan (what is reused, built, destroyed), asks about every judgement call, then has devboard build only the missing parts and binds the environment to this session. Use when the session receives `run /start-env <instruction>`, or the user asks to get an environment ready to reproduce an issue or test a behaviour.
---

# Start environment (Codex)

The user types this as `run /start-env <instruction>`. The procedure is agent-neutral and lives in
**`~/.agents/specs/env-agent.md`**. Read it in full now (and `~/.agents/specs/environments.md`, the
contract), then follow its `/start-env` section with the instruction you received.

Codex-specific notes:
- Use the shell for everything (`curl`, `npm`, `bash`); the procedure needs nothing else.
- Your session id is the current Codex session/thread id (the one `codex resume <id>` takes). If you
  can't determine it with certainty, ask the user. Send `"agent":"codex"` on every run/bind/teardown.

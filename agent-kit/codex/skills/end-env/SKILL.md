---
name: end-env
description: End this session's environment — releases its leases and removes the Env button from its learning/chore row, destroying nothing by default; optionally tears the infrastructure down first, after showing the plan. Use when the session receives `run /end-env`, or the user says they are done with an environment.
---

# End environment (Codex)

The user types this as `run /end-env`. The procedure is agent-neutral and lives in
**`~/.agents/specs/env-agent.md`**. Read it in full now (and `~/.agents/specs/environments.md`, the
contract), then follow its `/end-env` section.

Codex-specific notes:
- Use the shell for everything (`curl`, `bash`).
- Your session id is the current Codex session/thread id (the one `codex resume <id>` takes). If you
  can't determine it with certainty, ask the user. Send `"agent":"codex"` on a teardown.

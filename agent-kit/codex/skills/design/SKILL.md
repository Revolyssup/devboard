---
name: design
description: Work a devboard Design — the user's prose plus the facts, flags and targets derived from it. Use when the session receives `/design derive|verify|verify-all|rederive|prototype ... <ref>` (typed by devboard's Design buttons), or when the user challenges / gives advice about a fact, flag or target (F-7, X-2, T-3).
---

# Design (Codex)

devboard types these as `run /design …` into this Codex session. The procedure is agent-neutral and
lives in **`~/.agents/specs/design-agent.md`**. Read it in full now (and
`~/.agents/specs/design-facts.md`, the contract), then carry out the command exactly as it says.

Codex-specific notes:
- Use the shell for everything (`curl`, `git`, `bash`); the procedure needs nothing else.
- If you write to a learning/chore file as part of the work, only touch the `## Codex Section`
  (see `~/.agents/AGENTS.md`). The design's own files are governed by design-agent.md.

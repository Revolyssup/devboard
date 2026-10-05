---
name: agent-memory
description: Use the user's shared agent-neutral memory system for handoff and chore workflows across Codex and Claude.
---

# Agent Memory

Use this skill when the user asks for `/handoff`, or chore tracking in Codex.

Read `~/.agents/AGENTS.md` first, then the specific shared spec:

- Handoff: `~/.agents/specs/handoff.md`
- Start a chore: `~/.agents/specs/start-chore.md`
- End a chore: `~/.agents/specs/end-chore.md`
- Resume an existing chore: read `~/.agents/specs/start-chore.md` and follow its
  `Resume Chore` section.

Prefer the neutral paths under `~/.agents/data`. They are currently linked to the existing Claude
data directories, so writes remain visible to Claude and devboard.

When writing new provenance from Codex, identify the current Codex session id from the runtime
context when available; otherwise use the active id from `~/.codex/history.jsonl` only if it clearly
matches the current conversation. Record `agent: codex`.

When updating a shared learning or chore file, read the whole file but write only the
`## Codex Section` and update that section's `Last updated` timestamp, except for shared status
headings and frontmatter that must stay synchronized.

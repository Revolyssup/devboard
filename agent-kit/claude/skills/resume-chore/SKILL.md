---
name: resume-chore
description: Resume an existing shared chore file, usually from devboard, without creating a duplicate. Use when the user runs /resume-chore <path-to-chore-file>.
---

# /resume-chore

Read `~/.agents/AGENTS.md` and `~/.agents/specs/start-chore.md` before acting.

Given an existing chore file path:

1. Read the whole chore file and its directory's `index.txt`.
2. Identify the current Claude session UUID and current working directory.
3. Append `{agent: claude, id: <session-id>, directory: <cwd>}` to the file's `agent_sessions`
   frontmatter if it is not already present.
4. Append `claude:<session-id>` to the chore index row's `Session ID` cell if missing. Preserve
   any existing Claude or Codex sessions in that cell.
5. Continue the work from the current `What is done`, `What is happening`, and `What is pending`
   sections.
6. Read both `## Claude Section` and `## Codex Section`, but write only `## Claude Section` and
   update its `Last updated` timestamp.

Do not create a new chore file for this command.

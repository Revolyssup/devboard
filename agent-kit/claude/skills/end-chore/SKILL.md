---
name: end-chore
description: Close out a tracked chore — deletes its file from ~/.claude/chores and removes its index.txt row, after checking whether anything in it deserves a durable learning. Use when the user runs /end-chore, or says a chore/work item is finished and should stop being tracked.
---

# /end-chore — close a tracked chore

Chores are deliberately short-lived: they exist only while the work is in flight. This command
removes the chore so the dashboard's Work "Active chores" panel reflects only what is actually
open.

This command operates **only** on `~/.claude/chores/` (work chores). Personal chores are closed
with `/end-personal-chore`, which owns `~/.claude/personal/chores/`.

## Steps

0. **Read the shared contract first, every time this runs.** Read `~/.agents/AGENTS.md` and
   `~/.agents/specs/end-chore.md` before doing anything else below. The canonical work chore root
   is `~/.agents/data/chores/work` (`~/.claude/chores` is the compatibility path).

1. **Find the chore for this session.** Read `~/.claude/chores/index.txt` and locate the row
   whose `Session ID` column matches the current session UUID (the UUID segment of the
   scratchpad path in the system prompt).
   - No match, but exactly one chore exists → name it and ask the user to confirm before
     deleting.
   - No match and several chores exist → list them (title + filename) and ask which to end.
   - The user named a chore in the invocation (`/end-chore review-pr-1214`) → match on filename
     or title, confirming if ambiguous.

2. **Read the chore file before deleting it.** Two checks:
   - **Unfinished work:** if *What is pending* or *What is happening* still has bullets, say so
     and ask whether to end anyway. Do not delete over the user's head.
   - **Durable learning:** if the chore surfaced something reusable — a non-obvious root cause,
     a repo invariant, a trap that will bite again — say so and offer to run `/handoff` first.
     That writes it to `~/.claude/learnings/` where it persists and shows up in the dashboard's
     learnings table. Chore files are not a place to keep knowledge.

3. **Delete the chore file** `~/.claude/chores/<filename>`.

4. **Remove its row from `~/.claude/chores/index.txt`**, leaving the header line and every other
   row untouched. This is not optional — a stale index row makes the dashboard show a chore that
   no longer exists.

5. **Confirm in one line**: which chore was closed and whether a learning was captured.

## Notes

- Deleting a chore from the devboard UI does exactly the same two things (file + index row), so
  the two paths stay consistent.
- Never delete a chore whose session ID does not match the current session without explicit
  confirmation from the user — another live session may be tracking it.

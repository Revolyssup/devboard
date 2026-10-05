---
name: end-personal-chore
description: Close out a tracked personal chore — deletes its file from ~/.claude/personal/chores and removes its index.txt row, after checking whether anything in it deserves a durable personal learning. Use when the user runs /end-personal-chore, or says a personal chore is finished and should stop being tracked.
---

# /end-personal-chore — close a tracked personal chore

The personal counterpart of `/end-chore`. It operates **only** on
`~/.claude/personal/chores/` — never on `~/.claude/chores/`, which belongs to work chores and to
`/end-chore`.

Personal chores are deliberately short-lived: they exist only while the work is in flight. This
command removes the chore so the dashboard's Personal "Active chores" panel reflects only what is
actually open.

## Steps

0. **Read the shared contract first, every time this runs.** Read `~/.agents/AGENTS.md` and
   `~/.agents/specs/end-chore.md` before doing anything else below. The canonical personal chore
   root is `~/.agents/data/chores/personal` (`~/.claude/personal/chores` is the compatibility path).

1. **Find the chore for this session.** Read `~/.claude/personal/chores/index.txt` and locate the
   row whose `Session ID` column matches the current session UUID (the UUID segment of the
   scratchpad path in the system prompt).
   - No match, but exactly one chore exists → name it and ask the user to confirm before deleting.
   - No match and several chores exist → list them (title + filename) and ask which to end.
   - The user named a chore in the invocation (`/end-personal-chore two-sum-writeup`) → match on
     filename or title, confirming if ambiguous.

2. **Read the chore file before deleting it.** Two checks:
   - **Unfinished work:** if *What is pending* or *What is happening* still has bullets, say so and
     ask whether to end anyway. Do not delete over the user's head.
   - **Durable learning:** if the chore surfaced something reusable — a concept that finally
     clicked, a mistake worth a regression note, a mental model worth keeping — say so and offer to
     write it into `~/.claude/personal/learnings/` first, following that library's front-matter
     conventions and updating its `index.txt`. Chore files are not a place to keep knowledge.

3. **Delete the chore file** `~/.claude/personal/chores/<filename>`.

4. **Remove its row from `~/.claude/personal/chores/index.txt`**, leaving the header line and every
   other row untouched. This is not optional — a stale index row makes the dashboard show a chore
   that no longer exists.

5. **Confirm in one line**: which chore was closed and whether a learning was captured.

## Notes

- Deleting a chore from the devboard Personal panel does exactly the same two things (file + index
  row), so the two paths stay consistent.
- Never delete a chore whose session ID does not match the current session without explicit
  confirmation from the user — another live session may be tracking it.
- If the user's chore is job work, they want `/end-chore`, not this command.

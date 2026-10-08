---
name: verify-fact
description: Create one fact/flag/target in this session's devboard Design from a part of the user's prose that "Derive facts" missed. Use when the user runs /verify-fact <plain-text pointer to the part of the prose>.
---

# /verify-fact — derive one item that Derive missed

The user points at part of their design prose in plain words, e.g. `/verify-fact the bit where I say
anonymous requests are rejected`. Make **one** item out of it, using exactly the rules of
`/design derive`. Read `~/.claude/skills/design/SKILL.md` first (the "Rules" and "derive" sections).

1. Find the design. It's the one devboard opened for this session's learning/chore file. The `ref`
   is `<scope>/<kind>/<file.md>`. If you have seen a `/design ... <ref>` command in this session, use
   that ref. Otherwise `curl -s localhost:5178/api/design/list` and pick the entry for this
   session's file. If it's ambiguous, ask them.
2. `GET /api/design/state?ref=<ref>`. Locate the part of `doc` they mean. It may span several
   lines, so quote every fragment the claim rests on, verbatim. If an existing item already covers
   it, say which one and stop. If you can't locate it, quote your best candidates and ask.
3. Classify (fact / flag / target), anchor facts and flags in code at a pinned branch/sha, and create
   it with `POST /api/design/items` (one item).
4. Fix any anchor that failed verification. In the terminal, reply with the new id, its kind, and one
   line on why. It shows up in their sidebar right away. Verifying it at runtime is their next click
   (Verify), not yours.

---
name: learn-from-past
description: Look up ~/.claude/learnings via its index, open only the learning file(s) relevant to the current task, and pull their distilled findings into the session before continuing. Use when the user runs /learn-from-past, or when starting/stuck on something we've worked on before (a symptom, component, or incident with plausible prior art). The read-counterpart to /handoff.
---

# /learn-from-past — pull in prior-art learnings before continuing

Find and absorb the relevant write-ups from `~/.claude/learnings/` for whatever the session is working on, then hand back a short brief of what applies. This is the deliberate, explicit version of the lazy index lookup — invoke it when you want to *force* that lookup: at the start of a task with likely prior art, or when circling on a problem we've touched before.

This is the **read** side of the loop that `/handoff` **writes**. It must honor the same discipline: lazy (index first, open only matches), and pinned-commit-aware.

## Input

`/learn-from-past [topic] [all]`

- **With a topic** (e.g. `/learn-from-past waypoint teardown`): match the index against that topic.
- **No topic**: infer the subject from the current session — the files/repos open, the symptom being debugged, the components named in the conversation, the live hypothesis ledger if one exists (`<scratchpad>/hypothesis-ledger.md`). State the inferred subject before searching so the user can correct it.
- **`all` modifier** (bare `/learn-from-past all`, or trailing as in `/learn-from-past egress all`): **skip the picker entirely** — detect every relevant learning from the index and load them all into memory in one shot. Use this when the user already knows they want the full relevant set.

## Steps

1. **Entry-point docs first.** If the user's `CLAUDE.md` names an architecture/index learning as the entry point for the system being worked on, note it as a file to read regardless of the index match.

2. **Read the index, don't grep the directory.** Read only `~/.claude/learnings/index.txt` (pipe-separated: `Learning | Filename | Session ID(s)`). Never bulk-read or grep the whole `learnings/` directory — the one-line `Learning` summaries are the routing table.

3. **Select matching files.** Score each row's `Learning` summary against the task subject (symptom + component + insight). Pick the file(s) that plausibly cover it. Be selective:
   - Strong match → open it.
   - Plausible/adjacent → open it but flag it as a maybe.
   - No match → the matched set is empty; report "no prior art on this" and stop. A clean negative is a valid, useful result — do not force-fit an unrelated file.
   - Gather the **full set** of plausibly-relevant files here (don't pre-cap it) and order them by match strength — the picker in step 4 is what handles volume via pagination. Drop only the genuinely irrelevant.

4. **Present the picker** (skip this whole step when the `all` modifier was passed, or when 0 or exactly 1 file matched — 0 → report no prior art and stop; 1 → just load it). Otherwise let the user choose which of the matched learnings to load, using the `AskUserQuestion` tool:

   - The tool renders a selectable option box but **caps at 4 options per question**. Map "max 4 on screen, scroll if more" onto that cap by **paginating in batches of 3 learnings + a 4th control slot**, with `multiSelect: true` so they can tick several at once.
   - **Each question (one screen):**
     - Options 1–3: the next 3 matched learnings, ordered by match strength. Label = a short human title (from the file name / index summary); description = the one-line index `Learning` summary so they can judge relevance without opening the file.
     - Option 4 (control slot):
       - If more batches remain → **"⏬ Show more relevant learnings"**.
       - If this is the last (or only) batch → **"📚 Learn from all detected (N)"**, where N is the total matched count.
   - **Accumulate** the learnings they tick across screens. Behavior of the control slot:
     - "Show more" ticked → load nothing yet; carry the accumulated ticks forward and ask the next batch.
     - "Learn from all detected" ticked at any point → discard the partial selection, load **all** matched learnings, stop paginating.
     - Reaches the last screen without picking "all" → load exactly the accumulated ticked set.
   - The auto-added **"Other"** option lets them refine (e.g. type a narrower topic) — if they use it, re-run selection (step 3) with their refinement and present a fresh picker.
   - If they select nothing and dismisses → load nothing; report the matches by name so they can `/learn-from-past <one>` later.

5. **Open only the chosen files** and read them in full (they are already distilled — that's the point).

6. **Respect the pinned-commit contract.** Each learning file carries a header pinning exact full commit SHAs per repo. Its claims were true *at those refs*, not necessarily the working tree. When a finding is about to drive an action:
   - Treat file:line anchors and "the code does X" claims as valid **at the pinned SHA**. Verify against `git show <sha>:<path>` before acting on them, not the checked-out tree (which may have moved).
   - Note any drift you spot between the pinned claim and current code — that drift is itself a signal, and a candidate `/handoff` correction.

7. **Brief the user, don't dump.** Report:
   - **Which file(s)** were opened (path + the index summary line), and any that were considered but skipped.
   - **What applies to the current task** — the specific findings, mental models, invariants, or code anchors from those files that bear on what we're doing right now. Tie each back to the current problem; don't re-summarize the whole file.
   - **Open questions / RULED OUT carried forward** — if a file's hypothesis ledger left something open or ruled something out, surface it so we don't re-run a dead end or re-prove a known fact.
   - **Pinned refs** for anything load-bearing, with a note to verify at that SHA before relying on it.
   - If nothing matched: say so plainly and stop — no invented lessons.

## Rules

- **Index first, always.** The routing decision comes from `index.txt` summaries, never from scanning file bodies or the directory.
- **Open only what matches.** This skill is a scalpel, not a broom — the cost of the learnings library is paid only by reading the whole thing, which this must never do.
- **Learnings are dated snapshots, not current truth.** Anything that will drive a code change gets re-verified at the pinned SHA. Cite facts vs. what's merely recorded.
- **Feed the ledger.** If the session has a live hypothesis ledger, fold relevant PROVEN facts / RULED OUT entries from the learning file into it (attributed to the file + its pinned SHA), so `/bottom-line` and a later `/handoff` stay consistent.
- **Close the loop.** If reading a learning reveals it is stale, wrong, or superseded by this session, note it explicitly as a `/handoff` correction target — don't silently work around it.

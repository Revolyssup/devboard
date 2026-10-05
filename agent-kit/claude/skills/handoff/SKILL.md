---
name: handoff
description: Capture the current debugging/learning session into ~/.claude/learnings/ (create or update the session's learning file) and keep ~/.claude/learnings/index.txt in sync. Use when the user runs /handoff or asks to write up / hand off session learnings.
---

# /handoff — persist session learnings

Write (or update) a distilled learning file in `~/.claude/learnings/` for the current session, and keep `~/.claude/learnings/index.txt` accurate. The goal is a self-contained handoff a future session can act on without this session's context.

## Scope — which handoff is this?

The steps below are the **work** handoff (`~/.claude/learnings/`). If the session is a
personal (non-job) learning session, the handoff instead writes to
`~/.claude/personal/learnings/` with session provenance in front-matter (see
`~/.agents/specs/handoff.md`), not the steps below. The two differ in where session provenance lives: work records
`Session ID(s)` / `Directory` as index columns; personal records `session_id` / `directory` in the
learning file's front-matter (its index has no filename column to key on). Either way, **the
session id must be written at handoff time** — transcripts are pruned after ~30 days.

## Steps

0. **Read the shared contract first, every time this runs.** Read `~/.agents/AGENTS.md` and
   `~/.agents/specs/handoff.md` before doing anything else below. They define the canonical
   `~/.agents/data` paths (currently symlinked to `~/.claude` for compatibility) and the
   `agent_sessions` provenance format. This is a runtime prerequisite, not just a note for whoever
   edits this file.

1. **Identify the current session ID.** It is the UUID segment of the scratchpad directory path in the system prompt (`.../<project>/<SESSION-UUID>/scratchpad`).

2. **Check for an existing learning to update — in this order:**
   a. Read `~/.agents/data/sessions/index.jsonl` and look for a row whose `{agent, id}` matches
      this Claude session. If it has `learning_file`, **update that file** as the standing handoff
      target created by devboard. Do not create a duplicate.
   b. Otherwise, read `~/.claude/learnings/index.txt` and look for a row whose `Session ID(s)`
      column contains the current session ID → **update that file** (merge new findings into the
      existing structure; correct anything the session disproved; don't duplicate).
   c. Otherwise, scan the index `Learning` summaries: if an existing file clearly covers the same
      topic/incident (e.g. a multi-day investigation continued in a new session) → **update that
      file** and append the current session ID to its row (comma-separated).
   d. Otherwise → **create a new file**: `~/.claude/learnings/<yyyy-mm-dd>-<short-topic-slug>.md`,
      and append a new index row.

3. **Required file structure** (match the house style of existing files in the library):
   - Title + date + one-line context (what system/version/customer, what symptom).
   - **Pinned commits header**: a table of every repo referenced → exact full commit SHA the analysis was done against. Resolve branches/tags with `git rev-parse <ref>` — never pin a bare branch name. Note if any repo's working tree was dirty.
   - **TL;DR** — root cause or key mental model, a few lines.
   - **Verified findings** — the pipeline/mechanism as proven, with evidence commands (grep proof-kit style: exact commands + expected counts/output so they can be re-run).
   - **Hypothesis ledger** — copied from the session's live ledger (`<scratchpad>/hypothesis-ledger.md` if present, else reconstruct from the conversation): FACT (with evidence), HYPOTHESIS (still open), RULED OUT (with what killed it). This section is mandatory even if some buckets are empty.
   - **Code navigation anchors** — file:line references valid at the pinned SHAs, for picking up tomorrow.
   - **Open questions / next steps**.

4. **Sync the index.** The index is a 5-column pipe-separated table: `Learning | Filename | Session ID(s) | Directory | Last Updated`. Update (or add) the file's row:
   - `Learning`: one crisp line that signals *when a future session should open this file* — symptom + component + key insight. Rewrite it if the session changed the file's conclusions. Must contain no literal ` | ` (it would break column parsing).
   - `Filename`: the file name.
   - `Session ID(s)`: comma-separated list including the current session ID.
   - `Directory`: the absolute directory the session was launched from — i.e. where `cd <dir> && claude --resume <session-id>` will actually find the session. Derive it from the session transcript's `cwd`, not from the current `pwd` (which may have been `cd`-ed elsewhere mid-session):
     ```
     find ~/.claude/projects -name '<SESSION-UUID>.jsonl' | head -1 \
       | xargs grep -o '"cwd":"[^"]*"' | head -1 | sed 's/.*"cwd":"//;s/"$//'
     ```
     When a row lists multiple session IDs launched from different directories, keep the directory of the **most recent** session (the one this handoff is updating). Use `-` only for files with no associated session (e.g. hand-authored reference docs).
   - `Last Updated`: today's date in `YYYY-MM-DD`. **Set this to the current date on every handoff** — creation and each subsequent update — so the index shows recency at a glance.

5. **Report back**: show the user the file path and the exact index row written, and flag any HYPOTHESIS entries left open (those are the next session's starting point).

## Rules

- Never leave the index stale relative to the file — same-change updates only.
- Distill; don't dump transcript. Wrong turns belong in RULED OUT with one line each, not as narrative.
- Preserve corrections: if the session disproved something an existing learning file states, fix the file (and its index summary), don't append a contradiction.

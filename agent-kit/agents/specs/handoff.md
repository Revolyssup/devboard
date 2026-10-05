# Handoff Spec

Persist the current session into the shared learning library.

## Scope

- Work handoff: `~/.agents/data/learnings/work`
- Personal learning handoff: `~/.agents/data/learnings/personal`

Because these are currently symlinked to the existing Claude directories, this also preserves the
old `~/.claude/learnings` and `~/.claude/personal/learnings` behavior.

## Session Provenance

Record the current agent and session id.

- Claude: use the Claude session UUID and resume with `claude --resume <id>`.
- Codex: use the Codex thread/session id and resume with `codex resume <id>`.
- Before creating a new handoff file, check `~/.agents/data/sessions/index.jsonl` for a row whose
  `{agent, id}` matches the current session. If that row has `learning_file`, update that file as
  the standing handoff for the session instead of creating a duplicate.

When a file already has sessions, append the new `{agent, id, directory}` instead of replacing old
ones. Preserve legacy `session_id` / `directory` fields until all consumers understand
`agent_sessions`.

## Per-Agent Sections

Each learning file should contain both of these top-level sections:

```markdown
## Claude Section

- **Last updated:** <iso timestamp or ->
- <Claude-owned notes>

## Codex Section

- **Last updated:** <iso timestamp or ->
- <Codex-owned notes>
```

Every agent can read the whole file to continue from the previous agent's work, but each agent
only writes its own section. Shared status sections and frontmatter may be updated when needed to
keep the file accurate.

## Work Learning Index

Maintain `index.txt` with:

```text
Learning | Filename | Session ID(s) | Directory | Last Updated
```

Legacy rows are Claude rows. New rows may keep this format for compatibility, but the learning file
should also include structured session metadata when practical.

## Personal Learning Index

Maintain `index.txt` with:

```text
date | track | subtype | topic | outcome | confidence | mode | hints_used
```

Session provenance lives in file frontmatter, not this index.

## Rules

- Never replace another agent's section. Add or revise only the section for the agent doing the
  current work, and update that section's `Last updated` timestamp.
- Keep index rows synchronized with the file in the same change.

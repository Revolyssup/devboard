# Agent Memory Agreement

This directory is the agent-neutral home for the user's cross-session working memory.
Claude and Codex are adapters; the durable data contract lives here.

## Data Roots

- Work learnings: `~/.agents/data/learnings/work`
- Personal learnings: `~/.agents/data/learnings/personal`
- Work chores: `~/.agents/data/chores/work`
- Personal chores: `~/.agents/data/chores/personal`
- Agent session registry: `~/.agents/data/sessions/index.jsonl`

The current migration keeps these paths linked to the existing `~/.claude` data directories so
open Claude sessions and old commands keep working.

## Agent Session Provenance

Every new learning or chore should record the agent that created or updated it. Use a structured
session reference when possible:

```yaml
agent_sessions:
  - agent: claude
    id: 00000000-0000-4000-8000-000000000001
    directory: /Users/you/dev/some-repo
  - agent: codex
    id: 00000000-0000-7000-8000-000000000002
    directory: /Users/you/dev/some-repo
```

Legacy fields remain valid during migration:

- Work index `Session ID(s)` without an explicit agent means Claude.
- Personal frontmatter `session_id` without an explicit agent means Claude.
- Chore index `Session ID` without an explicit agent means Claude.

## Rules

- Do not move or delete `~/.claude` data as part of normal work. It remains a compatibility path.
- Keep learning and chore index rows synchronized with their files in the same change.
- Chores are ephemeral status files. Durable knowledge belongs in a learning file.
- Personal learning metadata belongs under personal learnings, not work learnings.
- Prefer the shared specs in `~/.agents/specs/` over agent-local command wording.
- Learning and chore files may be shared by multiple agents. Read the whole file, but only edit
  your own `## Claude Section` or `## Codex Section` unless updating shared status headings or
  structured provenance. Update your section's `Last updated` timestamp whenever you write it.

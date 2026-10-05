# Start Chore Spec

Create an ephemeral chore file in the shared chore library.

Before creating a new chore, check `~/.agents/data/sessions/index.jsonl` for a row whose
`{agent, id}` matches the current session. If that row has `chore_file`, update that
devboard-created chore file instead of creating a duplicate. Preserve its title unless the user
explicitly asks to rename it.

## Scope

- Work chore: `~/.agents/data/chores/work`
- Personal chore: `~/.agents/data/chores/personal`

## File Format

```markdown
---
agent_sessions:
  - agent: <claude|codex>
    id: <session-id>
    directory: <cwd>
---

# <Chore title>

- **Started:** <yyyy-mm-dd HH:MM>
- **Agent:** <claude|codex>
- **Session:** <session-id>
- **Directory:** <cwd>
- **Ask:** <raw user ask>

## What is done

- <nothing yet>

## What is happening

- <current action>

## What is pending

- <remaining steps>
```

The three section headings are load-bearing. Do not rename them.

`agent_sessions` is the structured provenance source. Keep it current when a different agent or
session takes over the chore. The legacy `Session:` and `Directory:` lines are compatibility
metadata for older Claude commands.

Each chore file should also contain both agent-owned sections:

```markdown
## Claude Section

- **Last updated:** <iso timestamp or ->
- <Claude-owned notes>

## Codex Section

- **Last updated:** <iso timestamp or ->
- <Codex-owned notes>
```

Every agent can read the whole chore, including the other agent's section, to continue the work.
Only write your own agent section. The shared `What is done`, `What is happening`, and `What is
pending` sections remain shared status and should stay current.

## Resume Chore

`resume chore <path-to-chore-file>` means: read the existing chore file, append the current
`{agent, id, directory}` to `agent_sessions` if missing, append the session to the chore index row
if needed, continue from the current shared status, and update only your own agent section.

## Index Format

Maintain `index.txt` with:

```text
Chore | Filename | Session ID | Directory | Started
```

Legacy consumers assume the `Session ID` column is Claude. New consumers should read `Agent:` from
the chore file when present, prefer frontmatter `agent_sessions` when present, and fall back to
Claude when absent.

After starting a chore, update it whenever the work state changes.

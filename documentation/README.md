# devboard documentation

devboard is a local browser dashboard for working with coding agents (Claude Code, Codex). It shows
the learnings and chores your agents write, runs agent sessions in the browser, and gives each
session a set of tools for understanding the code before changing it: reproducible environments, a
call-graph you build as you read, and design documents whose claims are checked against the code and
at runtime.

Start with setup, then read whichever feature you need.

| # | Doc | What it covers |
| --- | --- | --- |
| 1 | [Setup](01-setup.md) | Prerequisites, `install.sh`, running it (also in the background), updating, troubleshooting |
| 2 | [Learnings](02-learnings.md) | Work and Personal learnings tables, Active dots, read / edit / delete, search, progress report |
| 3 | [Chores](03-chores.md) | Tracking in-flight work with `/start-chore` … `/end-chore`, the Active chores panels |
| 4 | [Agent sessions](04-agent-sessions.md) | The browser terminal: ❯ Run, new sessions, parallel sessions, code links |
| 5 | [Environments](05-environments.md) | Composed, reusable test environments per session (`/start-env`) |
| 6 | [Code Ontology](06-code-ontology.md) | A call-graph diagram you build with the agent as you read code (`/codont`) |
| 7 | [Design](07-design.md) | Your prose → facts, flags and targets, verified against code and at runtime |
| 8 | [Reference](08-reference.md) | Configuration variables, HTTP API, data layout, shipped skills, development |

## How the pieces fit

```
 you ── write prose / click buttons ──▶  devboard (browser, localhost:5178)
                                              │  types commands into
                                              ▼
                                     agent session (Claude / Codex)
                                              │  follows skills + specs in
                                              ▼
                     ~/.claude/skills · ~/.codex/skills · ~/.agents/specs
                                              │  writes files under
                                              ▼
            ~/.agents/data (learnings, chores) · <file>.design/ · ~/.agents/{environments,codont}
                                              │
                                              └──▶ devboard reads them back and shows them
```

The dashboard never needs a database: everything is plain files you can read, grep and commit.

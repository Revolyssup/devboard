# Code Ontology

A Code Ontology ("codont") is a call-graph diagram of one piece of functionality, built only from
the code you have walked through or asked to have traced. The agent in your session draws it and
changes it as you talk, and devboard checks every box and arrow against the real code before
drawing it solid. Use it when a bug or feature cuts across many packages and you want the call
chain written down somewhere other than your head. It currently supports **Go only**.

> **Requirements.** The dashboard side (the 🕸️ button, the Ontology view, the API that verifies
> and stores the diagram) ships in this repo and works as-is. The `/codont` skill that starts a
> diagram and teaches the agent how to write it is **not** shipped: it is not in `agent-kit/`, and
> `scripts/install.sh` does not install it. Neither are the design spec
> (`~/.agents/specs/codont.md`) or the Go language contract (`~/.agents/codont/meta/go.md`). You
> need to install those separately.

## How it works

- **User-driven.** The diagram is not generated from the whole repo. It holds only what the
  instruction names and what you ask to add. What it leaves out is part of its value.
- **Verify before draw.** Every node and edge carries a `file:line` anchor. On every save the
  server resolves each anchor at the tab's version: for a pinned tab, the file must exist at that
  commit (`git show <sha>:<path>`) and the line must be within it; for the working-tree tab, the
  same check against the file on disk. Elements that fail are still drawn, in **red** (boxes with a dashed border),
  with the error on hover, so a claim that didn't check out stays visible.
- **The session's own agent writes it.** There is no second agent and no chat box in the diagram.
  You steer it by talking to the agent in the session's terminal. The agent sends changes to the
  server over HTTP; the server answers with what it added, what anchors it moved, what it dropped
  and what failed verification, and the agent is expected to fix failures before telling you it's
  done.
- **Layout is computed, not hand-drawn.** Positions come from the model, so two version tabs of
  the same functionality are comparable side by side. You can't drag boxes.

### Reading the diagram

| Element | Meaning |
| --- | --- |
| Box | A Go function or method. Shows the function name and its package. |
| Badge `s` on a box | Called on a concrete struct value. |
| Badge `i` on a box | Called through an interface value at the call site. |
| `calls` edge | Solid arrow; the callee sits one level below the caller. |
| `then` edge | Dashed arrow on the same level: called after. |
| `concurrent` edge | Dotted line with a dot in the middle and no arrowhead: runs concurrently. |
| No edge | No relationship is claimed. |
| Side arc | A call that closes a cycle (recursion), drawn faint and dashed. |
| Red | Failed verification: boxes get a red dashed border, edges turn red. Hover for the reason. |

## Using it

### Start it: `/codont <instruction>`

1. In an agent session whose working directory is the Go repo you want to trace, run
   `/codont <entry point or data flow>`, e.g.
   `/codont trace how a gateway config is built, starting at buildGatewayConfigs`.
2. The skill creates the ontology for this session with a **working tree** tab. If the session
   also has an [environment](05-environments.md) whose recorded provenance pins this repo to a
   commit other than `HEAD`, a second tab labelled `env @ <sha8>` is created too.
3. The agent reads the code the instruction names and writes the first version of the diagram.
4. Within about 10 seconds the 🕸️ button lights up on the session's row and the **Ontology**
   toggle in the terminal toolbar is enabled.

`/codont` runs once per session. Running it again is refused (HTTP 409) so it can't wipe the
diagram you've built up; further changes go through the agent.

### Open it

- **🕸️ on a row.** Every learning and chore row has a slot next to the Env button. It shows a
  greyed `◇` until the session has an ontology, then 🕸️. Click it to open **Code Ontology** as an
  overlay, with the original instruction under the title.
- **Ontology in the terminal.** In the session's terminal toolbar, **🕸️ Ontology** swaps the
  terminal view for the diagram while the session keeps running; the button then reads
  **Terminal** to switch back. It is disabled when the session has no ontology.

The view polls every 4 seconds, so changes the agent makes appear on their own.

### Evolve it by talking to the agent

In the session's terminal, say what you want in plain words:

- "add `handleProbe`"
- "also show the retry path"
- "drop the logging box"
- "what's the call between A and B?"

The agent reads the code, sends only the change (it merges by default rather than resending the
whole graph), and tells you in one line what changed and what verified. If the conversation drifts
away from what the diagram is mapping, the agent is expected to say so.

### The tab bar

| Control | What it does |
| --- | --- |
| Tabs | One per version. **working tree** is the files on disk. A pinned tab is labelled `<ref> @ <sha8>` (hover for the full SHA); the ref is resolved to a full SHA when the tab is created and never moves. |
| **⎇ diff** | Opens **Add a tab for another version**. Type a branch, tag or commit SHA (branch and tag suggestions appear as you type), then **Add tab**. The tab starts empty; ask the agent to build it at that ref. Adding a version that already has a tab fails. |
| **⚠️ N unverified** | How many elements on the current tab failed verification. Shown only when there are any. |
| **context** | The shared context: what is being mapped, entry points, scope decisions, and the environment's target and provenance if the session has one. Written by the agent; shared by every tab. |
| **journal** | The change log: each update's note, what was added, updated or removed, anchors the server moved, edges it dropped, and failures. |

All tabs share one context, so a second tab means "the same functionality at another version". An
empty or thin diagram on a pinned tab can be the honest answer: the code may not exist there.

If the session's environment runs a commit that no tab shows, a banner says so with an **Open tab
at env version** button.

### Clicking

| Action | Result |
| --- | --- |
| Click a box | Opens VS Code at the function's anchor, with the session's directory as the workspace. |
| Click an `s` / `i` badge | Opens VS Code at the struct or interface type definition. |
| Alt+click a box or badge | Opens the code peek pinned to the tab's commit. On the working-tree tab it shows the file on disk. |
| Drag the background | Pan. |
| Mouse wheel | Zoom. |

## Where the data lives

Everything is under `~/.agents/codont/` (override with `DEVBOARD_CODONT_ROOT`):

| Path | Contents |
| --- | --- |
| `meta/<lang>.md` | Language contracts, e.g. `go.md`: what boxes, badges and edges mean for that language. Not shipped with this repo. |
| `<session-id>/binding.json` | Session, instruction, repo directory (`cwd`), creation time. |
| `<session-id>/context.md` | The shared context shown under **context**. |
| `<session-id>/journal.md` | Append-only change log shown under **journal**. |
| `<session-id>/tabs.json` | The version tabs: id, ref, resolved SHA, label. |
| `<session-id>/tabs/<tabId>/ontology.json` | Nodes, edges, and the verification result for each. |
| `<session-id>/tabs/<tabId>/status.json` | Tab status. |

The environment link reads the session's binding from `~/.agents/environments/sessions/` and
recorded provenance from `~/.agents/environments/.provenance/by-key/`. Those files are written by
environment recipes, not by devboard, so an env tab appears only if your recipes record
provenance for the repo.

Agents are meant to change the diagram only through the API, never by editing these files: the API
is where verification happens.

## Good to know

- **Go only.** The server finds declarations with Go-shaped patterns (`func Name(`,
  `func (r T) Name(`, `type Name`, `var`/`const`). Anchors in other languages can still verify by
  line number, but symbol lookup won't find them.
- **Anchors must be inside the session's directory.** Paths are relative to the directory the
  ontology was started in; anything outside it fails verification with "outside the session
  directory".
- **Red boxes are failed claims.** Common causes: a line number past the end of the file, a file
  that doesn't exist at the pinned commit, or a symbol the server couldn't find. Ask the agent to
  fix them; it gets the exact error in the update response.
- **Pinned tabs must be built from that commit.** The agent should read code with `git show
  <sha>:<path>`, not the working tree, or the anchors describe the wrong version.
- **One ontology per session**, bound to one repo directory. To trace a different repo, use a
  different session.
- **Nothing to delete from the UI.** There is no button to remove a tab or an ontology; remove the
  `~/.agents/codont/<session-id>/` directory if you need to start over.
- Related: [04-agent-sessions.md](04-agent-sessions.md) for the terminal and its toolbar,
  [05-environments.md](05-environments.md) for environments, [07-design.md](07-design.md), and
  [08-reference.md](08-reference.md) for the `/api/codont/*` endpoints.

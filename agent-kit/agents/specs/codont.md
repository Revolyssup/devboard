# Code Ontology (codont)

Scope: per-session, user-driven call-graph diagrams. Go only for now; other languages get their
own contract file under `~/.agents/codont/meta/`.

Agent procedure: `~/.agents/specs/codont-agent.md`. Go contract: `~/.agents/codont/meta/go.md`.
Implementation: devboard's `server/lib/codont.js` and `server/routes/codont.js`. Where this file and
the code disagree, the code is what runs.

## Problem

Debugging a feature means holding a call chain in your head that cuts horizontally through many
packages, structs and interfaces. Editors are optimised for writing code, not for feature-focused
reading — so the mental model lives nowhere and evaporates between sessions. Whole-repo diagram
generators fail in the opposite direction: they draw everything, verified by nobody, and
reintroduce exactly the cognitive noise the diagram was meant to remove.

A codont is the middle: a diagram containing ONLY what the user has personally walked through or
explicitly asked to have traced — user-driven whiteboxing, one box at a time.

## The central rule

> **Verify before draw.** Every node and edge carries a `file:line` anchor, and the server
> resolves it at the tab's pinned ref before anything renders as solid. Unverifiable elements
> still render — in red, error on hover — so a claim that failed to check out is VISIBLE, never
> silently absent and never confidently wrong.

Solidity is the signal. A diagram whose every box clicks through to real code at a real commit is
itself the confidence artifact.

## Constructs

Per session: disabled until `/codont <instruction>` runs, 1:1 with the session, reachable from the
session's row and terminal toolbar in devboard.

```
~/.agents/codont/
  meta/<lang>.md                     language contracts (what boxes/badges/edges MEAN per language)
  <session-id>/
    binding.json                     {session, instruction, cwd, createdAt}
    context.md                       THE SHARED CONTEXT (see below)
    journal.md                       append-only audit trail of the agent's updates
    tabs.json                        [{id, ref, refResolved, label, createdAt}]
    tabs/<tabId>/ontology.json       the graph for that version, plus its verification
    tabs/<tabId>/status.json         {state: "idle", finishedAt?}
```

The root can be overridden with `DEVBOARD_CODONT_ROOT`. `cwd` is stored as its real path.

## Ontology schema

```jsonc
{
  "schema": 1,
  "nodes": [{
    "id": "orders.orderService.PlaceOrder",
    "label": "PlaceOrder",
    "pkg": "internal/orders",
    "via": "struct",                       // "direct" | "struct" | "interface"
    "recv": "orderService",                // struct/interface name; null when direct
    "viaAnchor": {"path": "internal/orders/service.go", "line": 18, "symbol": "orderService"},
                                           // where the recv type is declared; null when direct
    "anchor": {"path": "internal/orders/service.go", "line": 41, "symbol": "PlaceOrder"},
    "note": "one-liner, optional"
  }],
  "edges": [{
    "from": "api.Handler.CreateOrder", "to": "orders.orderService.PlaceOrder",
    "kind": "calls",                       // "calls" | "then" | "concurrent"
    "anchor": {"path": "internal/api/orders.go", "line": 58}   // the call site / sequencing point
  }],
  "verification": {                        // computed by the server on every save
    "orders.orderService.PlaceOrder": {"ok": true},
    "edge:0": {"ok": false, "error": "internal/api/orders.go has 40 lines; anchor says 58"}
  }
}
```

Semantics (rendering derives from these, never the other way round):

- `calls` — solid arrow; the callee is drawn one level BELOW the caller, flame-graph style. A call
  that closes a cycle (recursion) is drawn as a faint dashed side arc.
- `then` — same level, dashed arrow: "called after".
- `concurrent` — same level, dotted line with a mid dot, no arrowhead: neither ordered before the
  other.
- Nodes with no edges between them stay visually disconnected — absence of an arrow is a claim too.
- Badge `s`/`i` on a box = called via struct / interface; clicking the badge targets `viaAnchor`
  (the type's declaration), clicking the box targets `anchor` (the function).
- Failed verification: a box gets a red dashed border and red label; an edge turns red (its dash
  pattern stays that of its kind). The tab bar shows a count of unverified elements.

Layout is DETERMINISTIC from the model. That is what makes two version-tabs of the same
functionality visually comparable, and it is why there is no freehand canvas: hand-moved boxes
would decouple pixels from model and quietly kill diffing.

### Verification

Computed server-side on every save and attached as `verification`, keyed by node id or
`edge:<index>`. An anchor verifies iff:

- its path resolves inside the binding `cwd` (otherwise "outside the session directory");
- the file exists — at the tab's sha (`git show <sha>:<path>`) for a pinned tab, on disk for the
  working-tree tab;
- the line is within the file (`1 ≤ line ≤ number of lines`).

A node with `via` other than `direct` also needs its `viaAnchor` to verify. An edge without an
anchor fails as "missing anchor". Verification proves the location exists at that version; it does
not prove the line contains what the agent claims. Symbol anchors (below) close most of that gap.

Elements are NEVER dropped for failing verification — the failure is the information.

## Tabs = versions

The first tab is the working tree (`ref: null`). "Diff with another version" creates a tab pinned
to a branch/sha/tag, resolved to a full sha at creation and labelled `<ref> @ <sha8>`. A second tab
for an already-tabbed commit is refused (`409`). All tabs share ONE `context.md` — the statement of
what functionality is being mapped — so a second tab is "the same functionality at another
version", not a fresh diagram. If the functionality does not exist there, an empty/thin diagram at
that tab is the honest answer.

Node ids are stable identifiers (pkg + recv + name), so cross-tab comparison of "same box,
different anchor/edges" is mechanical.

## The shared context (`context.md`)

The sync point between the user, every tab, and the session's agent. `/start` writes a placeholder
holding the instruction. The agent replaces it in full by passing a non-empty `context` on an
update. It should contain: what is being traced and why; the entry point(s); current scope
decisions ("we are ignoring the retry path"); and, when the session has an environment, an
Environment section (target, instruction, provenance repo → sha).

The server does not write the Environment section itself. `/start` returns it as the `env` text
block, and `GET /state` returns the environment info; the agent includes it in `context`, labelled
as recorded provenance (a cache of belief, not probed truth). The user reads the context from the
`context` button on the tab bar.

## Who writes the diagram

**The session's own main agent, in its terminal, over HTTP.** There is no second agent and no
chat pane in the diagram view.

This was not the original design. The first version put a headless subagent behind a button in the
diagram view: the user typed a hypothesis there, the subagent read code and replied in prose ending
with a fenced JSON block, and the server regex-scraped that block back out. The scrape was the
whole contract, and it failed constantly — a preamble, a truncated reply, a stray backtick, and
the outcome was "unparseable output" and an unchanged diagram.

The design error was not the prompt. It was routing a structured write through an unstructured
channel, and doing it from a *second* agent that had to re-derive context the main agent already
had. So: the main agent writes, directly, typed.

## API

Base: `http://localhost:5178/api/codont`.

| Endpoint | Body / query | Does |
| --- | --- | --- |
| `POST /start` | `{session, instruction, cwd}` | Creates the binding, the working-tree tab and (see below) an env tab. Builds no diagram. `400` if a field is missing; `409` if the session already has one. Returns `binding`, `tabs`, `workingTabId`, `envTabCreated`, `envTabId`, `env`, `next`. |
| `POST /update` | `{session, tabId?, mode, nodes[], edges[], removeNodes[], removeEdges[], context?, note?}` | Applies a delta, verifies, saves, journals. `tabId` defaults to the working-tree tab. |
| `POST /tab` | `{session, ref}` | Creates an EMPTY pinned tab. `404` unknown ref, `409` duplicate commit. |
| `GET /state` | `?session=` | Binding, context, journal, all tabs with status and ontology, env info, `envMismatch`. |
| `GET /sessions` | — | Index of sessions that have an ontology (drives button enablement). |
| `GET /branches` | `?session=&q=` | Up to 20 branch/tag names, most recent first (for the diff popup). |

`/update` semantics:

- **Merge is the default**, and it is what makes follow-ups cheap: nodes upsert by `id` (the whole
  node is replaced), edges by `(from,to,kind)`. Replace exists for the initial build and
  deliberate rewrites.
- Validation is strict and loud (`400` naming the field): node `id`; `via` ∈ direct|struct|interface;
  `anchor.path` plus `line` or `symbol`; `viaAnchor.path` for non-direct nodes; edge `from`/`to`;
  `kind` ∈ calls|then|concurrent; `anchor.path` when an edge anchor is given.
- **Anchors may be symbolic**: `{path, symbol}` and the server finds the declaration line at the
  tab's version, using Go-shaped patterns (`func Name(` / `func Name[`, `func (r T) Name(`,
  `type Name`, `var|const Name`; first match wins). Line-number drift was the largest source of red
  elements, and an anchor the server located itself cannot drift. Given both, the symbol wins and
  the move is reported. A symbol that is not found keeps the given line (0 if none) and is reported.
- Removing a node removes every edge touching it. Edges naming a node id that does not exist are
  dropped and reported, never silently stored.
- **The response is the feedback loop**: `added`/`updated`/`removed`, `counts`, `resolved`
  (anchors the server moved or could not resolve by symbol), `dropped`, `failed` (elements whose
  anchor did not verify, as `{key, error}`), and the current `context`. The agent is expected to
  fix `failed` and re-send before reporting the change as done.

Every write is appended to `journal.md` — the note, what changed, what the server resolved, what it
dropped, what failed. The diagram owes the user an audit trail; it does not owe them a chatbot.

For pinned tabs the agent reads code via `git show <ref>:<path>`, never the working tree — the
diagram must describe the version its tab claims to.

`/codont` runs ONCE per session: it creates the binding and the tabs, and it does NOT build a
diagram. The agent builds it immediately afterwards with a `replace` update. Re-running `/codont`
is refused — it would destroy accumulated whiteboxing.

## Environment linkage

When the session has an environment binding (`~/.agents/environments/sessions/`) and recorded
provenance (`~/.agents/environments/.provenance/by-key/`, written by environment recipes):

- If provenance pins the traced repo to a SHA that differs from `HEAD`, `/start` creates a second
  tab at the env's SHA automatically, labelled `env @ <sha8>` — "what the environment is actually
  running" is a version tab like any other. Afterwards, a mismatch (no tab at the env's SHA) is
  surfaced in the view as a banner with a one-click tab create. The tab is created empty either
  way; filling it is the agent's job, which keeps "a diagram exists at this ref" from ever meaning
  "and nobody checked it".
- The env text block is returned to the agent for inclusion in `context.md` (see above).

## Interactions

Clicking behaves identically to code links elsewhere in devboard: click a box/badge → VS Code opens
the session cwd as workspace with the cursor on the anchor; Alt+click → the code peek pinned to the
tab's commit (working-tree tab → the file on disk). The view polls `/state` every few seconds.

## For agents

- Write the diagram through `POST /api/codont/update` only — never by editing `ontology.json`,
  `context.md` or `journal.md` on disk. The endpoint is where verification is applied; writing the
  files directly bypasses verify-before-draw, which is the one rule the construct exists to hold.
- Send the DELTA (merge), not the whole graph. Re-emitting everything to change one box is how a
  box quietly disappears.
- Anchors: prefer `{path, symbol}`. Check `failed` in the response and fix it before reporting the
  change as done — an unverified box is a claim with your name on it.
- When the user refers to the diagram ("the call between A and B"), read the active ontology and
  answer in the chat.
- If the conversation is drifting from `context.md`'s stated focus, say so.
- A red element is a failed verification: treat it as "claim did not check out", not as
  decoration.

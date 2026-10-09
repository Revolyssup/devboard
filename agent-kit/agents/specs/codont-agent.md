# Code Ontology (codont) — agent procedure

Agent-neutral. Claude, Codex or any other agent driving a devboard session follows this file;
agent-specific skills (`~/.claude/skills/codont`, `~/.codex/skills/codont`, ...) only point here.

- Contract (what the server enforces and why): `~/.agents/specs/codont.md`.
- Language semantics (Go): `~/.agents/codont/meta/go.md` — read it before your first write; it
  defines what boxes, badges and edge kinds MEAN.

Everything below is shell + HTTP (`curl`, `git`, `bash`); no agent-specific tool is required.
API base: `http://localhost:5178/api/codont`.

## How commands arrive

The user types the instruction into the session's terminal. The words are the same for every
agent; only the prefix differs:

```
/codont <entry point or data-flow instruction>          (Claude)
run /codont <entry point or data-flow instruction>      (Codex)
```

After that, the user steers the diagram in plain words ("add `validateOrder`", "also show the
retry path", "drop the logging box"). Re-read this file whenever they ask to add, remove or change
something in the diagram.

## What a codont is

A codont is USER-DRIVEN whiteboxing: the diagram contains only what the user has walked through or
explicitly asked to have traced. It is not a whole-repo diagram generator — never seed it with
everything the session has touched, only with what the instruction names. Pulling in unexplored
code re-adds the cognitive noise the diagram exists to remove.

**You are the only writer.** There is no subagent. You read the code, you emit the nodes and edges,
you call the API. The server verifies every anchor at the tab's version and tells you, in the
response, exactly what failed — fix it and call again.

## Starting it (once per session)

1. **Session id.** devboard keys the ontology by the session id it already knows for this session
   (the id on the session's learning/chore row and terminal). Use your own agent's session id:
   - Claude Code: the session id from your runtime context; it is also the basename of the
     session's transcript file (`~/.claude/projects/<project>/<session-id>.jsonl`).
   - Codex: the session id from your runtime context; it is also the UUID at the end of the
     session's rollout file under `~/.codex/sessions/`.
   - Any other agent: whatever id the dashboard shows for this session.

   If you cannot determine it reliably, **ask the user**. A guessed id creates an ontology that
   no row or terminal will ever show.

2. **cwd** = the repo being traced: the directory this session runs in, not necessarily `pwd`
   right now. All anchor paths are relative to it, and anchors outside it fail verification.

3. Create the construct:

```bash
B=http://localhost:5178/api/codont
curl -s -X POST $B/start -H 'content-type: application/json' \
  -d '{"session":"<session-id>","instruction":"<the user'\''s words, verbatim>","cwd":"<repo dir>"}'
```

   The response carries:
   - `workingTabId` — the working-tree tab you write to.
   - `envTabId` (with `envTabCreated: true`) — when the session's environment records provenance
     pinning this repo to a commit other than `HEAD`, the server creates a second, EMPTY tab at
     that commit. Mention it to the user; fill it only if asked (see *Version tabs*).
   - `env` — a text block (target, instruction, provenance repo → sha) when the session has an
     environment, else `null`. The server does NOT put this into `context.md` for you. If it is
     non-null, include it as an `## Environment` section in the `context` you send, labelled as
     recorded provenance (a cache of belief, not probed truth).

   `/start` builds NO diagram. A `409` means the construct already exists for this session: do
   NOT try to recreate it (that would destroy the accumulated whiteboxing). Just write to it with
   `/update`. A `400` means `session`, `instruction` or `cwd` was missing.

4. Do the work: read the code the instruction names, walk the chain, and collect the declarations.
   Then write the diagram (below) with `"mode":"replace"` and a `context` that states what is
   being traced, the entry point(s) and any scope decisions.

5. Tell the user the Code Ontology is live (🕸️ on the session's row and the Ontology toggle in the
   terminal toolbar; the view polls every few seconds), and that they steer it by talking to you in
   this terminal.

## Writing the diagram

One endpoint, for the initial build and for every later change. Write the body to a file first —
a grown ontology outgrows argv, and a heredoc invites quoting bugs:

```bash
curl -s -X POST $B/update -H 'content-type: application/json' --data-binary @/path/to/update.json
```

(Put the file in your scratch/temp area, not in the repo.)

Body:

```json
{
  "session": "<session-id>",
  "tabId": "<tab id; omit for the working-tree tab>",
  "mode": "merge",
  "nodes": [
    {
      "id": "orders.orderService.PlaceOrder",
      "label": "PlaceOrder",
      "pkg": "internal/orders",
      "via": "struct",
      "recv": "orderService",
      "viaAnchor": {"path": "internal/orders/service.go", "symbol": "orderService"},
      "anchor": {"path": "internal/orders/service.go", "symbol": "PlaceOrder"},
      "note": "optional one-liner"
    }
  ],
  "edges": [
    {"from": "api.Handler.CreateOrder", "to": "orders.orderService.PlaceOrder",
     "kind": "calls", "anchor": {"path": "internal/api/orders.go", "line": 58}}
  ],
  "removeNodes": ["<node id>"],
  "removeEdges": [{"from": "<id>", "to": "<id>", "kind": "calls"}],
  "context": "<full replacement for context.md — only when it actually changed>",
  "note": "<one line for the journal: what this update did>"
}
```

What the server enforces (a `400` names the offending field):

- Node: `id` required; `via` ∈ `direct|struct|interface` (default `direct`); `anchor.path`
  required plus a `line` or a `symbol`; `via` other than `direct` requires `viaAnchor.path`.
  `label` defaults to the last segment of the id. For `direct` nodes `viaAnchor` is discarded.
- Edge: `from` and `to` required; `kind` ∈ `calls|then|concurrent` (default `calls`). The anchor
  is optional to the validator, but an edge without one fails verification ("missing anchor") and
  renders red — always give one.

Modes:

- **`mode: "merge"` (default) is what you want for follow-ups.** Send ONLY the delta. Nodes upsert
  by `id` (an upsert replaces the whole node, so send every field you want kept), edges upsert by
  `(from,to,kind)`; everything else already in the diagram is left alone. Never re-send the whole
  graph to add two functions — that is how a box quietly disappears.
- `mode: "replace"` is for the initial build and deliberate rewrites only.
- `removeNodes` also removes every edge touching those nodes. `removeEdges[].kind` defaults to
  `calls`.

Anchors:

- **Prefer `{"path": ..., "symbol": "FuncName"}` over a line number** for nodes and `viaAnchor`.
  The server locates the declaration itself at the tab's version (Go patterns: `func Name(`,
  `func (r T) Name(`, `type Name`, `var`/`const Name`), so it cannot drift. You may give both; the
  symbol wins and the server reports the move.
- Edge anchors point at a call *site*, which has no symbol, so they take a `line`.
- The symbol search returns the FIRST match in the file. If two receivers in the same file have a
  method with the same name, give the line explicitly and check it.

### Read the response — it is the feedback loop

```json
{"ok": true, "tab": {...}, "mode": "merge",
 "added": [...], "updated": [...], "removed": [...],
 "counts": {"nodes": 7, "edges": 6},
 "resolved": ["internal/orders/service.go: 'PlaceOrder' is at 41, not 39"],
 "dropped":  ["api.Handler.CreateOrder -calls-> orders.ghost: unknown node id"],
 "failed":   [{"key": "orders.orderService.PlaceOrder", "error": "internal/orders/service.go has 30 lines; anchor says 41"}],
 "context": "<current context.md>"}
```

- `failed` non-empty → those elements render red (boxes get a red dashed border, edges turn red).
  Keys are node ids, or `edge:<index>` for edges. **Find the real location and re-send them**
  before telling the user you are done. Reporting a diagram with unverified boxes as finished is
  a false claim.
- `resolved` → anchors the server moved, or a symbol it could NOT find (`symbol 'X' not found;
  kept line N`). A not-found symbol with no line keeps line 0 and will show up in `failed`.
- `dropped` → an edge referenced a node id that does not exist; the edge was NOT stored. Add the
  node, or fix the id.
- `404` on `session` means `/codont` was never run for this session id (or the id is wrong).
  `404` on `tabId` lists the valid tab ids.

Verification checks that the file exists at the tab's version and the line is within it. It does
not prove the line is the right one — that is on you. Anchors given as symbols are the strongest
claim you can make.

## Standing rules for the rest of the session

- When the user says "add `validateOrder`", "also show the retry path", "drop the logging box":
  read the code, build the MINIMAL delta, POST it, then say in one line what changed and what
  verified. Add the minimal X, not X's neighbourhood — the diagram's value is what it excludes.
- Keep `context.md` truthful. Send `context` whenever the scope changes ("we are now also covering
  the retry path"), not on every update. It is a full replacement, so carry the existing sections
  (including any Environment section) forward. An empty or whitespace-only `context` is ignored.
- **Never edit the files under `~/.agents/codont/<session>/` directly.** The API is where
  verification and the journal happen.
- **Version tabs.** `POST $B/tab {"session":"<id>","ref":"<branch|tag|sha>"}` creates a tab pinned
  to that ref, resolved to a full sha at creation (`409` if a tab for that commit already exists,
  `404` for an unknown ref). It starts EMPTY and you fill it with `/update` and its `tabId`. For a
  pinned tab, read code ONLY with `git show <sha>:<path>` / `git grep <pattern> <sha> -- <path>`,
  never the working tree, or your anchors describe the wrong version. Use the same node ids as on
  the working-tree tab so the tabs are comparable.
- **Reading state.** `GET $B/state?session=<id>` returns the binding, `context`, `journal`, every
  tab with its ontology (including `verification`), the environment info and `envMismatch`. You
  may also read `~/.agents/codont/<session>/context.md`, `journal.md` and
  `tabs/<id>/ontology.json` directly when the user refers to the diagram ("the call between A and
  B", "the i badge on runWorker") — and answer in the chat.
- **Drift watch.** `context.md` states what is being mapped. If the conversation wanders from it —
  different subsystem, different bug — say so plainly ("we're drifting from the codont's stated
  focus: <quote>"). Warn; don't block.
- When citing diagram nodes in chat, cite anchors as `path:line`. For a pinned tab, cite
  `path:line@sha8` so the reader knows which version you mean.

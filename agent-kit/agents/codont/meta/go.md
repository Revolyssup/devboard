# Go language contract for codont diagrams

How Go code maps onto the ontology schema (`~/.agents/specs/codont.md`). Other languages get their
own file; the schema is shared, the MEANING of `via`, badges and edges is per-language.

The examples below use a generic Go HTTP service: `internal/api` (handlers), `internal/orders`
(business logic), `internal/store` (persistence).

## Nodes

A node is a function or method the user has whiteboxed (walked through, or explicitly asked to
have traced). Never add nodes for code merely passed through unless asked.

- `id`: stable across versions — `<pkg last segment>.<recv or "">.<FuncName>`, e.g.
  `orders.orderService.PlaceOrder`, `orders..NewService` (empty recv for free functions). Ids are
  the cross-tab diff key: the same functionality at two refs must produce the same id.
- `label`: the bare function name.
- `pkg`: import-path-relative directory, e.g. `internal/orders`.
- `anchor`: the `func` declaration of THIS version (it moves between refs; that is fine — the id
  is stable, the anchor is per-tab truth).

## `via` — how the call reaches the function

- `direct` — free function, `main`, an exported package function called as `pkg.Fn(...)`.
  No badge.
- `struct` — method with a concrete receiver (`func (s *orderService) PlaceOrder(...)`), called on
  a concrete value. Badge `s`; `recv` = the struct name; `viaAnchor` = the `type X struct`
  declaration.
- `interface` — the CALL SITE goes through an interface value (the static type at the call site
  is an interface, whatever concrete type sits behind it at runtime). Badge `i`; `recv` = the
  interface name; `viaAnchor` = the `type X interface` declaration. When the user has established
  which concrete implementation runs, note it in `note` ("impl: postgresRepo") — the badge stays
  `i` because the code path dispatches through the interface.

Judgement rule: `via` describes the call-site dispatch, not the definition. A struct method
invoked through an interface variable (e.g. `s.repo.Save(...)` where `repo` is a
`store.Repository`) is `interface` here.

## Edges

- `calls` — from caller to callee; `anchor` = the call-site line in the caller. Draws the callee
  one level down.
- `then` — A `then` B: within some enclosing frame, B is invoked after A returns. Anchor = B's
  call site. Only assert `then` when order is real (sequential statements, loop body order);
  if order is incidental or unknown, use no edge.
- `concurrent` — A and B run concurrently relative to each other (`go` statements, errgroup,
  parallel workers). Anchor = the `go`/spawn site. Undirected.

Goroutines: the function launched by `go f(...)` is `calls` from the launcher (one level down)
AND `concurrent` with whatever the launcher does next, when that matters to the trace.

Channels: a data handoff worth drawing is an edge `kind: "then"` with a note ("via ch
events") only when the user asks for data-flow; do not decorate every channel.

## What NOT to draw

- Standard library and vendored third-party frames, unless the user names them.
- Error-return plumbing (`if err != nil { return err }` chains).
- Logging, metrics, tracing calls.
- Every caller of a hot function — only the path(s) inside the stated context.

The diagram's value is what it EXCLUDES. When the user asks to "add X", add the minimal X, not
X's neighbourhood.

## Reading code for a pinned tab

Use `git show <ref>:<path>` and `git grep <pattern> <ref> -- <path...>` exclusively. The working
tree is a DIFFERENT version; mixing them produces anchors that verify against the wrong content.
For the working-tree tab, read files directly.

## Anchors

- Node anchor: the line of the `func` keyword.
- viaAnchor: the line of the `type` keyword.
- Edge anchor: the line containing the call expression (or `go` keyword).

Node and via anchors name a declaration, so give them as `{"path": ..., "symbol": "FuncName"}`
and let the server find the line at the tab's version — a line you counted can be stale by the
time you send it; a symbol cannot. The server matches `func Name(` / `func Name[`,
`func (r T) Name(`, `type Name`, and `var`/`const Name`, and takes the FIRST match in the file: if
two types in the same file declare a method with the same name, pass the `line` too and check the
response. Edge anchors point at a call *site*, which has no symbol, so those take a `line`.

Paths are relative to the binding cwd (the repo the session runs in). Every anchor you emit is
verified by the server at the tab's ref; an anchor that does not resolve renders the element red.
If you are not sure of a line, FIND it — an unverified guess is visible to the user as a failed
claim with your name on it.

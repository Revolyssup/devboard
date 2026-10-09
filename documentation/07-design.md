# Design (✎)

A Design is a plain document you write in your own words: how you think part of the system behaves,
what you want it to do, bugs you've seen, design worries. The session's agent reads it alongside the
code and turns it into **facts** (the code agrees with you), **flags** (the code disagrees) and
**targets** (things you want). Each item is tied to the exact words you wrote and to code at a pinned
commit. A fact only turns green once a runtime script has proven it: you can copy that script
anywhere and run it yourself. Use it before changing a system you don't fully understand: you end up
with a short, checked list of what's actually true, instead of guesses.

Works with Claude Code and Codex. Contract: [`agent-kit/agents/specs/design-facts.md`](../agent-kit/agents/specs/design-facts.md).
The procedure every agent follows: [`agent-kit/agents/specs/design-agent.md`](../agent-kit/agents/specs/design-agent.md).

## Using it

### Open it

- Click **✎** on any learning or chore row. It opens that row's agent session (the open terminal if
  there is one, else the row's most recently active Claude or Codex session, else a new session with
  the agent you last used) and puts the Design window on top of it.
- Or click **✎ Design** in a session terminal's toolbar.

The window is fullscreen: your prose on the left, **Derived facts** on the right. The session's
terminal keeps running behind it. **❯ Terminal** takes you there; **✎ Design** brings you back.
Clicking outside the window doesn't close it.

Drag the bar between the two sides to resize them (double-click it to reset). The width is
remembered in this browser.

### Write

The left side is a plain editor that saves as you type. Write anything, in any shape. If you want to
say how something should be tested, put it under a `## Environment` heading; the agent reads that
section when it verifies or prototypes.

Only you write this document. Agents never edit it.

### Derive

| Button | What happens |
| --- | --- |
| **Derive facts** | The agent reads the whole document and the code, and creates an item for every claim and wish it finds. It skips anything an existing item already covers and never rewrites existing items, so you can press it again after adding text. |
| **Derive from selection** | Select one or more lines first and the button changes to this. The agent still reads the whole document for context, but only creates items for claims in your selection. The server refuses any new item that doesn't quote from inside the selection. |
| `/verify-fact <which part>` (typed in the terminal) | For something Derive missed: `/verify-fact the bit where I say anonymous requests are rejected`. Creates one item. In Codex: `run /verify-fact …`. |

Items appear when the agent finishes. A full Derive creates them in one go, so "Deriving…" can take a
while; use **❯ Terminal** to watch.

Each item quotes the fragments of your prose it came from. A claim can span several lines, and every
line it touches gets a coloured dot in the editor's margin. Click an item to highlight its words in
the editor; click a dot to select the item.

### Read an item

| Kind | Id | Dot | Meaning |
| --- | --- | --- | --- |
| Fact | `F-7` | orange → **green** | Current behaviour the code agrees with. Orange: checked against code. Green: proven at runtime. |
| Flag | `X-7` | red ring → **solid red** | Current behaviour as you described it, but the code says otherwise. Solid once the contradiction is confirmed at runtime. |
| Target | `T-7` | grey ring | Something you want. No code yet. |

The number is stable; the letter follows the kind (T-3 can become F-3). Badges: **auto** means the
agent chose the kind, **source changed** means some quoted words are no longer in your prose,
**frozen** means a target's test is locked (see Prototype), **was target** means a fact came from a
prototype.

Expanding an item shows:

- the claim, and the agent's explanation;
- `branch @ sha` it was checked against;
- **Quoted from your prose**: struck through if you've since deleted them;
- **Code**: each referenced code block at that sha (click to open it in a pinned code view), or the
  prototype diff for a fact that came from a target;
- **Experiment**: `verify.sh`, `inputs/`, `control/`, and the folder path;
- **Runs**: every run with its result (`pass` / `fail` / `cannot-run`), the sha it ran against and its
  duration. Expand one for `log.txt` and the evidence files the script saved. Faded runs ran an
  older version of the script.

### Verify

| Button | What happens |
| --- | --- |
| **Verify** (on a fact or flag) | The agent writes `inputs/`, a `control/` variant where the claim should *not* hold, and `verify.sh`, then asks the server to run it twice: normally and with `--control`. |
| **Verify all (n)** (sidebar header) | Every orange fact that has never been run, one at a time (they share the environment). Each turns green or red as it finishes; it stops at the first "couldn't run". |
| **Re-run** | Runs the existing `verify.sh` and its control again. No agent involved. |

A fact turns **green** only when the normal run passes *and* the control run fails, from the same
script. That second half stops a script that can't fail from proving anything. Editing `verify.sh` or
its inputs drops the item back to orange until it's run again.

`verify.sh` exit codes: `0` claim holds, `1` it doesn't, `2` couldn't run here (missing cluster,
tool or image). `2` is never shown as a failure. The **server** runs the script; the exit code is the
result, and the agent can't report one itself.

Every item's folder is self-contained: copy it anywhere and run `./verify.sh` (or
`./verify.sh --control`) to check that one claim yourself.

### Prototype (targets)

Click **Prototype** on a target and give a branch name (existing, or new to create one). The agent
follows a fixed order, and the server enforces it:

1. Writes `verify.sh` for the behaviour you want, before any code.
2. Runs it against the base. It **must fail**; if it passes, the target already holds and the agent
   stops. A failing run **freezes** the script and inputs.
3. Changes only product code on the branch, rebuilding and re-running until the script passes. If it
   thinks the frozen script is wrong, it stops and asks you; only your go-ahead (journalled) unlocks it.
4. Re-runs every fact already on that branch, and reports anything it broke.
5. The target becomes a fact on `branch@sha`, with the prototype diff as its code. The server only
   allows this when the same script failed on base and passed on the branch.

### Change your mind

| You want to… | Do this |
| --- | --- |
| Correct or clarify an item | Edit your prose, then click **Re-derive** on the item. The agent re-reads the whole document and the code, then keeps it, sharpens it, reclassifies it (e.g. a flag becomes a fact once your wording matches the code) or retires it if you no longer say it. |
| Get rid of a flag | Delete its lines from your prose: it moves to **Resolved flags**. Or Re-derive it. There's no Remove button on flags. |
| Drop a fact or target | **Remove**. It's kept under `removed/`, not deleted. |
| Argue about one item | Go to **❯ Terminal** and talk to the agent: "X-2: use the config with mTLS off", "F-7's control isn't a real negation". It changes that item only and records your words in the journal. |

There's no button to change an item's kind. What an item *is* follows from your prose and the code,
so you change the prose and Re-derive. The server only lets the agent reclassify a flag, or retire
anything, while you have a Re-derive open on that item. A target can become a fact through Re-derive
only if Derive misread a claim about today as a wish and nothing has been prototyped yet.

## Where the data lives

Next to the learning or chore file the design belongs to:

```
<learnings or chores dir>/<file>.design/
  design.md          your prose (only the editor writes it)
  binding.json       repo, next item number, open Derive request
  journal.md         every change and run: who, what, why
  fixtures/          setup shared by several items
  items/7/
    item.json        claim, kind, quoted fragments, repo, branch, sha, code anchors, prototype diff
    verify.sh  inputs/  control/
    runs/<time>-<mode>/   run.json (exit, result, sha, env), log.txt, sentinel/ (evidence)
  removed/           items you removed or the agent retired, with the reason
```

If your learnings directory is in git, these folders (including run evidence) get committed with it.

## Good to know

- **Buttons need a live terminal.** Every agent action is typed into the session's terminal as a
  visible command (`/design derive …`, `/design verify F-7 …`). If the terminal isn't connected, the
  buttons are disabled.
- **The spinner is a request, not a process.** If an agent stops halfway, clear a stuck spinner with
  **Clear** on the item, or **✕** next to "Deriving…".
- **Environments.** Verify never builds infrastructure itself. It uses the session's environment (see
  [05-environments.md](05-environments.md)) or what your `## Environment` section says, and returns
  `cannot-run` if it isn't there.
- **Agent sessions that were already running** keep the skills they loaded at start. Restart them after
  updating devboard.
- **What the server enforces** (no matter which agent): quotes must really be in your prose; results
  come only from running `verify.sh`; target scripts freeze after failing on base; promotion needs a
  failing base run and a passing branch run of the same script; flags change kind, and items get
  retired, only during a Re-derive you asked for.

See also: [04-agent-sessions.md](04-agent-sessions.md) for the terminal the Design window drives,
[08-reference.md](08-reference.md) for the `/api/design` routes.

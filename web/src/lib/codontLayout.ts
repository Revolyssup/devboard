/**
 * Deterministic flame-graph layout for a codont ontology.
 *
 * Layout is a pure function of the model — that is the property that makes two version tabs of
 * the same functionality visually comparable, and it is why there is no freehand positioning.
 *
 * Rules (per the spec):
 *   - `calls` edges nest: callee one level below its caller, packed under it.
 *   - `then` / `concurrent` edges order siblings left→right on the same level but do not nest.
 *   - Nodes with no relationship stay apart; each root starts its own column block.
 *   - Recursion (a `calls` cycle) is broken for LAYOUT ONLY at the back edge; the edge still
 *     renders, as a curve, because hiding it would misrepresent the code.
 */

export interface OntNode {
  id: string;
  label: string;
  pkg: string;
  via: 'direct' | 'struct' | 'interface';
  recv: string | null;
  viaAnchor: { path: string; line: number } | null;
  anchor: { path: string; line: number };
  note?: string;
}

export interface OntEdge {
  from: string;
  to: string;
  kind: 'calls' | 'then' | 'concurrent';
  anchor: { path: string; line: number } | null;
}

export interface Verification {
  [key: string]: { ok?: boolean; error?: string };
}

export interface LaidNode extends OntNode {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

export interface LaidEdge extends OntEdge {
  index: number;
  /** true when this `calls` edge closes a cycle and was excluded from nesting. */
  back: boolean;
}

export interface Layout {
  nodes: LaidNode[];
  edges: LaidEdge[];
  width: number;
  height: number;
}

export const BOX_H = 36;
const GAP_X = 22;
const GAP_Y = 34;
const CHAR_W = 7.3;

function boxWidth(n: OntNode): number {
  const badge = n.via !== 'direct' ? 16 : 0;
  return Math.max(96, Math.round(n.label.length * CHAR_W) + 24 + badge);
}

export function layoutOntology(
  nodes: OntNode[],
  edges: OntEdge[]
): Layout {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Children via `calls`, in edge order; back-edges (cycles) detected with a DFS stack.
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  const backEdges = new Set<number>();

  edges.forEach((e, i) => {
    if (e.kind !== 'calls' || !byId.has(e.from) || !byId.has(e.to)) return;
    // Tentatively record; cycle check below decides whether it nests.
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from)!.push(e.to);
    hasParent.add(e.to);
    void i;
  });

  // Remove cycle-closing child links (DFS from every potential root; grey/black colouring).
  const state = new Map<string, 1 | 2>();
  const dropChild = (parent: string, child: string) => {
    const list = children.get(parent);
    if (!list) return;
    const at = list.indexOf(child);
    if (at !== -1) list.splice(at, 1);
    // Mark every matching calls edge as a back edge for rendering.
    edges.forEach((e, i) => {
      if (e.kind === 'calls' && e.from === parent && e.to === child) backEdges.add(i);
    });
  };
  const dfs = (id: string) => {
    state.set(id, 1);
    for (const c of [...(children.get(id) || [])]) {
      const s = state.get(c);
      if (s === 1) dropChild(id, c);
      else if (!s) dfs(c);
    }
    state.set(id, 2);
  };
  for (const n of nodes) if (!state.has(n.id)) dfs(n.id);

  // A node kept as a child of one parent nests there once; extra parents' links become back
  // edges so the tree stays a tree.
  const seenChild = new Set<string>();
  for (const n of nodes) {
    for (const c of [...(children.get(n.id) || [])]) {
      if (seenChild.has(c)) dropChild(n.id, c);
      else seenChild.add(c);
    }
  }

  // Sibling order: stable topo by `then` edges among a sibling set (fallback: existing order).
  const thenAfter = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.kind !== 'then') continue;
    if (!thenAfter.has(e.to)) thenAfter.set(e.to, new Set());
    thenAfter.get(e.to)!.add(e.from);
  }
  const orderSiblings = (ids: string[]): string[] => {
    const out: string[] = [];
    const pending = [...ids];
    let guard = pending.length * pending.length + 1;
    while (pending.length && guard-- > 0) {
      const idx = pending.findIndex((id) => {
        const before = thenAfter.get(id);
        return !before || ![...before].some((b) => pending.includes(b));
      });
      out.push(...pending.splice(idx === -1 ? 0 : idx, 1));
    }
    return out.concat(pending);
  };

  const roots = orderSiblings(nodes.filter((n) => !seenChild.has(n.id)).map((n) => n.id));

  // Recursive packing: a subtree's width is max(own box, packed children), children centered.
  const pos = new Map<string, { x: number; y: number; w: number; depth: number }>();
  const subtreeWidth = (id: string): number => {
    const kids = orderSiblings(children.get(id) || []);
    const own = boxWidth(byId.get(id)!);
    if (kids.length === 0) return own;
    const kidsW = kids.reduce((a, k) => a + subtreeWidth(k), 0) + GAP_X * (kids.length - 1);
    return Math.max(own, kidsW);
  };
  const place = (id: string, x: number, depth: number) => {
    const stw = subtreeWidth(id);
    const own = boxWidth(byId.get(id)!);
    pos.set(id, { x: x + (stw - own) / 2, y: depth * (BOX_H + GAP_Y), w: own, depth });
    let cx = x;
    for (const k of orderSiblings(children.get(id) || [])) {
      place(k, cx, depth + 1);
      cx += subtreeWidth(k) + GAP_X;
    }
  };

  let cursor = 0;
  for (const r of roots) {
    place(r, cursor, 0);
    cursor += subtreeWidth(r) + GAP_X * 2;
  }

  const laidNodes: LaidNode[] = nodes.map((n) => {
    const p = pos.get(n.id) || { x: cursor, y: 0, w: boxWidth(n), depth: 0 };
    return { ...n, x: p.x, y: p.y, w: p.w, h: BOX_H, depth: p.depth };
  });

  const laidEdges: LaidEdge[] = edges.map((e, i) => ({ ...e, index: i, back: backEdges.has(i) }));

  const width = Math.max(cursor, ...laidNodes.map((n) => n.x + n.w)) + GAP_X;
  const height = Math.max(0, ...laidNodes.map((n) => n.y + n.h)) + GAP_Y;
  return { nodes: laidNodes, edges: laidEdges, width, height };
}

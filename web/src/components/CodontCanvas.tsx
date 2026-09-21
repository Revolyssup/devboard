import { useMemo, useRef, useState } from 'react';
import { layoutOntology, BOX_H } from '../lib/codontLayout';
import type { OntNode, OntEdge, Verification, LaidNode } from '../lib/codontLayout';

/**
 * The diagram surface: model-driven SVG, no freehand. Pan by dragging the background, zoom with
 * the wheel. Click semantics are the SAME as code links everywhere else in devboard — click a box
 * (or badge) opens VS Code at its anchor; Alt+click opens the pinned peek — so the diagram adds
 * no new interaction rules, only a new view.
 *
 * Verification failures render, styled broken (red/dashed, error on hover). Absence would hide
 * the fact that a claim failed; wrongness would hide that it was never checked. Broken-but-
 * visible is the honest middle.
 */

export interface AnchorClick {
  path: string;
  line: number;
  alt: boolean;
}

export function CodontCanvas({
  nodes,
  edges,
  verification,
  onAnchor,
}: {
  nodes: OntNode[];
  edges: OntEdge[];
  verification: Verification;
  onAnchor: (a: AnchorClick) => void;
}) {
  const layout = useMemo(() => layoutOntology(nodes, edges), [nodes, edges]);
  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  const [view, setView] = useState({ x: -20, y: -20, zoom: 1 });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    setView((v) => ({ ...v, zoom: Math.min(2.5, Math.max(0.3, v.zoom * factor)) }));
  };
  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as Element).closest('[data-node]')) return; // node clicks are not pans
    drag.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!drag.current) return;
    const d = drag.current;
    setView((v) => ({ ...v, x: d.ox - (e.clientX - d.sx) / v.zoom, y: d.oy - (e.clientY - d.sy) / v.zoom }));
  };
  const endDrag = () => (drag.current = null);

  const vOf = (key: string) => verification[key];
  const isBroken = (key: string) => vOf(key)?.ok === false;

  const edgePath = (from: LaidNode, to: LaidNode, kind: string, back: boolean) => {
    if (back) {
      // Cycle-closing call: a side arc, so recursion is visible without wrecking the nesting.
      const x1 = from.x + from.w;
      const y1 = from.y + BOX_H / 2;
      const x2 = to.x + to.w;
      const y2 = to.y + BOX_H / 2;
      const bulge = 46;
      return `M ${x1} ${y1} C ${x1 + bulge} ${y1}, ${x2 + bulge} ${y2}, ${x2} ${y2}`;
    }
    if (kind === 'calls') {
      const x1 = from.x + from.w / 2;
      const y1 = from.y + BOX_H;
      const x2 = to.x + to.w / 2;
      const y2 = to.y;
      return `M ${x1} ${y1} C ${x1} ${y1 + 16}, ${x2} ${y2 - 16}, ${x2} ${y2}`;
    }
    // then / concurrent: lateral, box edge to box edge.
    const leftFirst = from.x <= to.x;
    const x1 = leftFirst ? from.x + from.w : from.x;
    const x2 = leftFirst ? to.x : to.x + to.w;
    const y1 = from.y + BOX_H / 2;
    const y2 = to.y + BOX_H / 2;
    return `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
  };

  return (
    <svg
      className="codont-svg"
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <defs>
        <marker id="codont-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" className="codont-arrowhead" />
        </marker>
      </defs>
      <g transform={`scale(${view.zoom}) translate(${-view.x}, ${-view.y})`}>
        {layout.edges.map((e) => {
          const from = byId.get(e.from);
          const to = byId.get(e.to);
          if (!from || !to) return null;
          const broken = isBroken(`edge:${e.index}`);
          const cls = `codont-edge ${e.kind}${broken ? ' broken' : ''}${e.back ? ' back' : ''}`;
          const d = edgePath(from, to, e.kind, e.back);
          const midX = (from.x + from.w / 2 + to.x + to.w / 2) / 2;
          const midY = (from.y + to.y + BOX_H) / 2;
          return (
            <g key={`e${e.index}`}>
              <path
                d={d}
                className={cls}
                markerEnd={e.kind === 'then' || (e.kind === 'calls' && !e.back) ? 'url(#codont-arrow)' : undefined}
              >
                <title>
                  {e.kind}
                  {broken ? ` — ${vOf(`edge:${e.index}`)?.error}` : e.anchor ? ` @ ${e.anchor.path}:${e.anchor.line}` : ''}
                </title>
              </path>
              {e.kind === 'concurrent' && <circle cx={midX} cy={midY} r={3.2} className="codont-concurrent-dot" />}
            </g>
          );
        })}

        {layout.nodes.map((n) => {
          const broken = isBroken(n.id);
          return (
            <g
              key={n.id}
              data-node
              className={`codont-node${broken ? ' broken' : ''}`}
              transform={`translate(${n.x}, ${n.y})`}
              onClick={(e) => {
                e.stopPropagation();
                onAnchor({ path: n.anchor.path, line: n.anchor.line, alt: e.altKey });
              }}
            >
              <rect width={n.w} height={n.h} rx={7} />
              <text x={n.via !== 'direct' ? 24 : 12} y={BOX_H / 2 - 2} className="codont-label">
                {n.label}
              </text>
              <text x={n.via !== 'direct' ? 24 : 12} y={BOX_H / 2 + 11} className="codont-pkg">
                {n.pkg}
              </text>
              <title>
                {broken
                  ? `FAILED VERIFICATION: ${vOf(n.id)?.error}`
                  : `${n.anchor.path}:${n.anchor.line}${n.note ? `\n${n.note}` : ''}\nclick → VS Code · alt-click → peek`}
              </title>
              {n.via !== 'direct' && n.viaAnchor && (
                <g
                  className={`codont-badge ${n.via}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAnchor({ path: n.viaAnchor!.path, line: n.viaAnchor!.line, alt: e.altKey });
                  }}
                >
                  <circle cx={0} cy={0} r={8} />
                  <text x={0} y={3.5}>{n.via === 'struct' ? 's' : 'i'}</text>
                  <title>{`${n.via} ${n.recv ?? ''} — ${n.viaAnchor.path}:${n.viaAnchor.line}`}</title>
                </g>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

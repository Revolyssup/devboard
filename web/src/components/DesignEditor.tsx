import { useEffect, useRef } from 'react';
import { EditorState, RangeSet, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, keymap, placeholder, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';

/**
 * The prose pane. Deliberately bare — a column of text, no toolbar — because this is where Ashish
 * dumps thoughts, and the agent never writes here.
 *
 * Two overlays come from the sidebar: a margin dot on every line an item's quoted fragments touch
 * (colour = the item's state), and a highlight over the fragments of the selected item.
 */

export interface EditorMark {
  id: string;
  tone: string; // css class suffix: fact-code, fact-ok, flag, target, bad, muted
  quotes: string[];
}

/** Find a fragment in the doc, ignoring whitespace differences (the server matches the same way). */
export function findQuote(doc: string, quote: string): { from: number; to: number } | null {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
  const m = re.exec(doc);
  return m ? { from: m.index, to: m.index + m[0].length } : null;
}

class DotMarker extends GutterMarker {
  constructor(readonly dots: { id: string; tone: string }[]) {
    super();
  }
  eq(other: DotMarker) {
    return other.dots.map((d) => d.id + d.tone).join() === this.dots.map((d) => d.id + d.tone).join();
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'design-gutter-dots';
    for (const d of this.dots.slice(0, 3)) {
      const dot = document.createElement('span');
      dot.className = `design-dot tone-${d.tone}`;
      dot.title = d.id;
      dot.dataset.id = d.id;
      el.appendChild(dot);
    }
    return el;
  }
}

const setMarks = StateEffect.define<{ marks: EditorMark[]; selected: string | null }>();

const marksField = StateField.define<{ gutter: RangeSet<GutterMarker>; hl: DecorationSet }>({
  create: () => ({ gutter: RangeSet.empty, hl: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return build(tr.state, e.value.marks, e.value.selected);
    if (!tr.docChanged) return value;
    return { gutter: value.gutter.map(tr.changes), hl: value.hl.map(tr.changes) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.hl),
});

function build(state: EditorState, marks: EditorMark[], selected: string | null) {
  const doc = state.doc.toString();
  const perLine = new Map<number, { id: string; tone: string }[]>();
  const hl: Range<Decoration>[] = [];
  for (const m of marks) {
    for (const q of m.quotes) {
      const r = findQuote(doc, q);
      if (!r) continue;
      const a = state.doc.lineAt(r.from).number;
      const b = state.doc.lineAt(r.to).number;
      for (let ln = a; ln <= b; ln++) {
        const list = perLine.get(ln) || [];
        if (!list.some((x) => x.id === m.id)) list.push({ id: m.id, tone: m.tone });
        perLine.set(ln, list);
      }
      if (m.id === selected && r.to > r.from) hl.push(Decoration.mark({ class: 'design-hl' }).range(r.from, r.to));
    }
  }
  const gutterRanges = [...perLine.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([ln, dots]) => new DotMarker(dots).range(state.doc.line(ln).from));
  return {
    gutter: RangeSet.of(gutterRanges),
    hl: Decoration.set(hl.sort((x, y) => x.from - y.from)),
  };
}

const theme = EditorView.theme({
  '&': { height: '100%', background: 'transparent', color: 'var(--text)' },
  '.cm-scroller': {
    justifyContent: 'center',
    // Same face as the session terminal, so prose and agent output read as one surface.
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: '14px',
    lineHeight: '1.7',
    padding: '48px 0 30vh',
  },
  // gutter + text column are centred together, so the dots sit right beside the prose
  '.cm-content': { flexGrow: 0, width: '84ch', maxWidth: 'calc(100% - 40px)', caretColor: 'var(--accent)', padding: '0 12px' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': { background: 'transparent', border: 'none' },
  // Absolutely positioned, so the empty first line keeps one line's height (otherwise the cursor
  // stretches over the whole wrapped placeholder).
  '.cm-placeholder': { color: 'var(--faint)', position: 'absolute', pointerEvents: 'none', width: '100%' },
  '.cm-line:has(.cm-placeholder)': { position: 'relative' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'rgba(196,167,231,0.25) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
});

export function DesignEditor({
  initial,
  marks,
  selected,
  onChange,
  onPickMark,
  onSelection,
}: {
  initial: string;
  marks: EditorMark[];
  selected: string | null;
  onChange: (doc: string) => void;
  onPickMark: (id: string) => void;
  /** The selected prose (expanded to whole lines), or null when nothing is selected. */
  onSelection?: (text: string | null) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onPickRef = useRef(onPickMark);
  onPickRef.current = onPickMark;
  const onSelRef = useRef(onSelection);
  onSelRef.current = onSelection;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          placeholder(
            'Write what you understand about the system and where you want it to go. Behaviour, design worries, bugs, how to set up an environment (under a "## Environment" heading) — anything.'
          ),
          marksField,
          gutter({
            class: 'design-gutter',
            markers: (vw) => vw.state.field(marksField).gutter,
            domEventHandlers: {
              mousedown: (_vw, _line, ev) => {
                const id = (ev.target as HTMLElement)?.dataset?.id;
                if (id) onPickRef.current(id);
                return Boolean(id);
              },
            },
          }),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
            if (u.selectionSet || u.docChanged) {
              const r = u.state.selection.main;
              if (r.empty) onSelRef.current?.(null);
              else {
                // Whole lines: a claim rarely starts exactly where the mouse did.
                const from = u.state.doc.lineAt(r.from).from;
                const to = u.state.doc.lineAt(r.to).to;
                const text = u.state.sliceDoc(from, to);
                onSelRef.current?.(text.trim() ? text : null);
              }
            }
          }),
        ],
      }),
    });
    view.current = v;
    v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor owns the text after mount; `initial` is only the first value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: setMarks.of({ marks, selected }) });
  }, [marks, selected]);

  // Bring the selected item's first fragment into view.
  useEffect(() => {
    const v = view.current;
    if (!v || !selected) return;
    const m = marks.find((x) => x.id === selected);
    const doc = v.state.doc.toString();
    const r = m?.quotes.map((q) => findQuote(doc, q)).find(Boolean);
    if (r) v.dispatch({ effects: EditorView.scrollIntoView(r.from, { y: 'center' }) });
    // only when the selection changes, not on every poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  return <div className="design-editor" ref={host} />;
}

import { useEffect, useMemo, useRef } from "react";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  gutter,
  GutterMarker,
  Decoration,
} from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { bracketMatching, indentOnInput, foldGutter, foldKeymap, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { completionKeymap } from "@codemirror/autocomplete";
import { linter, type Diagnostic } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import { nginx } from "./nginx-syntax";
import { modelLines, syntaxError, type ModelLine } from "./model-highlight";

// ── Light theme ──────────────────────────────────────────
const lightTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "#1e293b" },
  ".cm-gutters": { backgroundColor: "transparent", color: "#94a3b8", borderRight: "1px solid #e2e8f0" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#475569" },
  ".cm-activeLine": { backgroundColor: "oklch(0.95 0.01 155 / 0.3)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "oklch(0.85 0.04 155 / 0.4) !important" },
  ".cm-cursor": { borderLeftColor: "#1e293b" },
  ".cm-matchingBracket": { backgroundColor: "oklch(0.88 0.05 155 / 0.5)", outline: "none" },
  ".cm-foldGutter": { color: "#94a3b8" },
  ".cm-tooltip": { backgroundColor: "#ffffff", border: "1px solid #e2e8f0" },
  ".cm-tooltip-autocomplete": { backgroundColor: "#ffffff" },
}, { dark: false });

const lightHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: "#94a3b8", fontStyle: "italic" },
  { tag: tags.keyword, color: "#8b5cf6" },
  { tag: tags.string, color: "#059669" },
  { tag: tags.number, color: "#d97706" },
  { tag: tags.variableName, color: "#0891b2" },
  { tag: tags.propertyName, color: "#2563eb" },
  { tag: tags.operator, color: "#64748b" },
  { tag: tags.punctuation, color: "#64748b" },
  { tag: tags.typeName, color: "#8b5cf6" },
  { tag: tags.definition(tags.variableName), color: "#2563eb" },
  { tag: tags.function(tags.variableName), color: "#7c3aed" },
  { tag: tags.bool, color: "#d97706" },
  { tag: tags.null, color: "#d97706" },
  { tag: tags.atom, color: "#d97706" },
]));

// ── Dark theme ───────────────────────────────────────────
const darkTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "#e2e8f0" },
  ".cm-gutters": { backgroundColor: "transparent", color: "#6272a4", borderRight: "1px solid #334155" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#94a3b8" },
  ".cm-activeLine": { backgroundColor: "oklch(0.25 0.005 250 / 0.4)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "oklch(0.35 0.02 250 / 0.5) !important" },
  ".cm-cursor": { borderLeftColor: "#f8f8f2" },
  ".cm-matchingBracket": { backgroundColor: "oklch(0.35 0.05 155 / 0.5)", outline: "none" },
  ".cm-foldGutter": { color: "#6272a4" },
  ".cm-tooltip": { backgroundColor: "#1e293b", border: "1px solid #334155", color: "#e2e8f0" },
  ".cm-tooltip-autocomplete": { backgroundColor: "#1e293b" },
}, { dark: true });

const darkHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: "#6272a4", fontStyle: "italic" },
  { tag: tags.keyword, color: "#bd93f9" },
  { tag: tags.string, color: "#50fa7b" },
  { tag: tags.number, color: "#f1fa8c" },
  { tag: tags.variableName, color: "#8be9fd" },
  { tag: tags.propertyName, color: "#66d9ef" },
  { tag: tags.operator, color: "#94a3b8" },
  { tag: tags.punctuation, color: "#94a3b8" },
  { tag: tags.typeName, color: "#bd93f9" },
  { tag: tags.definition(tags.variableName), color: "#66d9ef" },
  { tag: tags.function(tags.variableName), color: "#ff79c6" },
  { tag: tags.bool, color: "#f1fa8c" },
  { tag: tags.null, color: "#f1fa8c" },
  { tag: tags.atom, color: "#f1fa8c" },
]));

function isDark() {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

// ── Model-line highlighting (Task 6) ────────────────────
// Marks lines the reverse-sync classifier (`~/lib/nginx/reverse/classify.ts`,
// via `modelLines`) would map back onto a host field. Purely informational —
// these lines stay fully editable, this just tells the user the system
// already understands them.

const modelHighlightTheme = EditorView.baseTheme({
  ".cm-model-gutter": { width: "0.9em" },
  ".cm-model-marker": { color: "#10b981", fontSize: "0.7em" },
  ".cm-model-line": { backgroundColor: "oklch(0.85 0.08 160 / 0.12)" },
});

class ModelFieldMarker extends GutterMarker {
  constructor(private readonly field: string) {
    super();
  }
  eq(other: GutterMarker): boolean {
    return other instanceof ModelFieldMarker && other.field === this.field;
  }
  toDOM(): Node {
    const span = document.createElement("span");
    span.className = "cm-model-marker";
    span.title = `→ ${this.field}`;
    span.textContent = "●";
    return span;
  }
}

function buildModelHighlightExtensions(marks: ModelLine[], doc: Text) {
  const byLine = new Map(marks.map((m) => [m.line, m.field]));

  const modelGutter = gutter({
    class: "cm-model-gutter",
    lineMarker(view, line) {
      const lineNo = view.state.doc.lineAt(line.from).number;
      const field = byLine.get(lineNo);
      return field ? new ModelFieldMarker(field) : null;
    },
  });

  const ranges = [];
  for (const [lineNo, field] of byLine) {
    if (lineNo < 1 || lineNo > doc.lines) continue;
    const line = doc.line(lineNo);
    ranges.push(Decoration.line({ class: "cm-model-line", attributes: { title: `→ ${field}` } }).range(line.from));
  }
  ranges.sort((a, b) => a.from - b.from);

  return [modelGutter, EditorView.decorations.of(Decoration.set(ranges))];
}

// Live syntax diagnostic — reuses `syntaxError()` from Task 1 (design record
// §refusal 6). Never a second implementation. `@codemirror/lint`'s own
// `delay` option provides the ~300ms debounce off `onChange`.
const nginxLinter = linter(
  (view) => {
    const problem = syntaxError(view.state.doc.toString());
    if (!problem) return [];
    const lineNo = Math.min(Math.max(problem.line, 1), view.state.doc.lines);
    const { from, to } = view.state.doc.line(lineNo);
    const diagnostic: Diagnostic = { from, to, severity: "error", message: problem.message };
    return [diagnostic];
  },
  { delay: 300 }
);

interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  onSave?: (value: string) => void;
  readOnly?: boolean;
  className?: string;
  onRegisterInsert?: (fn: (text: string) => void) => void;
  /** Registers a function that moves the cursor to a given 1-based line and
   *  scrolls it into view. Used by ApplyDialog's refusal rows so clicking a
   *  refusal jumps straight to the offending line. */
  onRegisterJumpToLine?: (fn: (line: number) => void) => void;
}

export function CodeEditor({ value, onChange, onSave, readOnly = false, className, onRegisterInsert, onRegisterJumpToLine }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const modelHighlightComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onRegisterInsertRef = useRef(onRegisterInsert);
  const onRegisterJumpToLineRef = useRef(onRegisterJumpToLine);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onRegisterInsertRef.current = onRegisterInsert;
  onRegisterJumpToLineRef.current = onRegisterJumpToLine;

  // Recomputed on every value change (including live edits, since `value`
  // reflects the buffer after `onChange` round-trips through the parent).
  const marks = useMemo(() => modelLines(value), [value]);

  // Initialize editor once on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        run: (view) => {
          onSaveRef.current?.(view.state.doc.toString());
          return true;
        },
      },
    ]);

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current?.(update.state.doc.toString());
      }
    });

    const dark = isDark();
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        indentOnInput(),
        foldGutter(),
        highlightSelectionMatches(),
        nginx(),
        themeComp.current.of(dark ? [darkTheme, darkHighlight] : [lightTheme, lightHighlight]),
        modelHighlightTheme,
        modelHighlightComp.current.of([]),
        nginxLinter,
        saveKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, ...completionKeymap]),
        updateListener,
        EditorState.readOnly.of(readOnly),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    onRegisterInsertRef.current?.((text: string) => {
      const pos = view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, insert: text },
        selection: { anchor: pos + text.length },
      });
    });

    onRegisterJumpToLineRef.current?.((line: number) => {
      const clamped = Math.max(1, Math.min(line || 1, view.state.doc.lines));
      const linePos = view.state.doc.line(clamped);
      view.dispatch({
        selection: { anchor: linePos.from, head: linePos.from },
        effects: EditorView.scrollIntoView(linePos.from, { y: "center" }),
      });
      view.focus();
    });

    // Watch for dark mode changes via MutationObserver
    const observer = new MutationObserver(() => {
      const nowDark = isDark();
      view.dispatch({
        effects: themeComp.current.reconfigure(
          nowDark ? [darkTheme, darkHighlight] : [lightTheme, lightHighlight]
        ),
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      observer.disconnect();
      view.destroy();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update content when value prop changes externally
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentValue = view.state.doc.toString();
    if (currentValue !== value) {
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
    }
  }, [value]);

  // Re-derive the model-line gutter marker + background whenever the
  // model-owned lines change (including the initial mount). Editing stays
  // fully enabled on these lines — this is informational only.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: modelHighlightComp.current.reconfigure(buildModelHighlightExtensions(marks, view.state.doc)),
    });
  }, [marks]);

  return <div ref={containerRef} className={className} />;
}

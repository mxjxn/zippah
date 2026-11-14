// CodeMirror 6 editor: vim mode + autocomplete over zippah's own language
// and the live Generant studio (device names, bank patterns, params).
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, completionKeymap, startCompletion } from "@codemirror/autocomplete";
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { vim } from "@replit/codemirror-vim";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";

// Static zippah surface for completions; the dynamic Generant source is
// supplied at creation time so it always reflects the live snapshot.
const ZIPPAH_WORDS = [
  "defsynth", "demo", "boot", "stop", "metro", "at", "apply-by", "beat-loop", "seq-loop",
  "stop-loop", "pdef", "pstop", "pbind", "pseq", "pxrand", "pwhite", "pexprand", "p+",
  "note", "scale", "chord", "sample", "play", "synthdefs", "ctl", "kill", "tree", "help",
  "generant/connect", "generant/refresh", "generant/state", "generant/devices", "generant/patterns",
  "generant/banks", "generant/play", "generant/stop", "generant/tempo", "generant/pattern",
  "generant/note", "generant/lane", "generant/device", "generant/help",
];

// One unified completion source: CM6 merges multiple sources only when they
// agree on `from`, so devices/banks/patterns and zippah words come from here
// together. Generant options always apply as quoted strings.
function combinedSource(getSnapshot) {
  return (context) => {
    const word = context.matchBefore(/["\w\-]+/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const text = word.text;
    const quoted = text.startsWith('"');
    const needle = (quoted ? text.slice(1) : text).toLowerCase();
    if (!needle && !quoted && !context.explicit) return null;
    let snap;
    try {
      snap = getSnapshot();
    } catch {
      snap = null;
    }
    const options = ZIPPAH_WORDS.map((label) => ({ label, type: "function" }));
    if (snap?.connected) {
      for (const d of snap.devices ?? []) {
        options.push({ label: `"${d.name}"`, detail: `${d.type} — g-device`, type: "variable", boost: 2, apply: `"${d.name}"` });
      }
      for (const def of snap.banks?.defs ?? []) {
        for (const p of def.patterns ?? []) {
          options.push({ label: `"${p.name}"`, detail: `${def.name} bank pattern`, type: "enum", apply: `"${p.name}"` });
        }
      }
      for (const p of snap.patterns ?? []) {
        options.push({ label: `"${p.name}"`, detail: "Generant song pattern", type: "class", apply: `"${p.name}"` });
      }
    }
    const filtered = options.filter((o) => o.label.toLowerCase().includes(needle));
    return filtered.length ? { from: word.from, options: filtered } : null;
  };
}

export function createEditor({ parent, initial, onChange, onEval, onStop, getSnapshot }) {
  const comp = new Compartment();
  const vimComp = new Compartment();

  const evalKeymap = [
    { key: "Mod-Enter", run: () => (onEval() ?? true), preventDefault: true },
    { key: "Mod-.", run: () => (onStop() ?? true), preventDefault: true },
  ];

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initial,
      extensions: [
        lineNumbers(),
        history(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle),
        StreamLanguage.define(clojure),
        vimComp.of(vim()),
        autocompletion({
          override: [combinedSource(getSnapshot)],
          activateOnTyping: true,
          icons: false,
        }),
        keymap.of([...evalKeymap, ...completionKeymap, ...searchKeymap, indentWithTab, ...defaultKeymap]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && onChange) onChange(u.state.doc.toString());
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px", background: "#141a17", color: "#d7e2d0" },
          ".cm-gutters": { background: "#101512", color: "#5a6a5e", border: "none" },
          ".cm-activeLine": { background: "#1a221d" },
          ".cm-activeLineGutter": { background: "#1a221d" },
          ".cm-content": { caretColor: "#c9a86d" },
          ".cm-tooltip": { background: "#1e2622", border: "1px solid #394544" },
          ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "#2c3a31" },
        }),
      ],
    }),
  });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    selection: () => {
      const { from, to } = view.state.selection.main;
      return { from, to, text: view.state.doc.sliceString(from, to) };
    },
    flash: () => {
      view.dom.classList.add("flash");
      setTimeout(() => view.dom.classList.remove("flash"), 150);
    },
    startCompletion: () => {
      view.contentDOM.focus();
      startCompletion(view);
    },
  };
}

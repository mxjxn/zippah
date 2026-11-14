import { PRELUDE as prelude } from "./prelude.js";
import { createEngine } from "./engine.js";
import { createRepl } from "./repl.js";
import { createGenerant } from "./generant.js";
import { createEditor } from "./editor.js";
import "./style.css";

const $ = (id) => document.getElementById(id);
const host = $("editor");
const out = $("output");
const statusEl = $("status");
const bootBtn = $("boot");
const evalBtn = $("eval");

const SEED = `;; Boot, then Cmd/Ctrl-Enter evaluates the selection (or everything). Cmd/Ctrl-. stops.
(demo 3 (* 0.15 (rlpf (saw [110 110.6]) (line:kr 300 3000 3) 0.3)))

(defsynth pluck-bass [note 40 amp 0.35 cutoff 1400]
  (* amp (env-gen (perc 0.005 0.35) :action FREE)
     (rlpf (saw (midicps note)) cutoff 0.25)))

(def m (metro 118))
(seq-loop :bass m 0.5 [40 nil 40 43 nil 47 45 nil] (fn [n] (pluck-bass n)))
(beat-loop :kick m (fn [b] (play :sc808_bassdrum {:amp 1.5})))

;; try: (m :bpm 132)   (stop-loop :kick)   (help)   (stop)

;; patterns: select these lines and Cmd/Ctrl-Enter (re-evaluate to swap live)
;; (pdef :lead (pbind :instrument pluck-bass
;;                    :note (p+ (pxrand [0 3 7 10 12] :inf) 64)
;;                    :dur (pseq [0.5 0.25 0.25] :inf)
;;                    :amp (pwhite 0.15 0.3 :inf :float)
;;                    :cutoff (pexprand 600 4000 :inf))
;;       {:metro m :quant 4})
;; (pstop :lead)

;; Generant bridge — with the Generant desktop app running:
;; (generant/connect) (generant/devices) (generant/help)
;; (def bass (generant/device "Bass Lane"))
;; (bass :pattern "i-dotted" 3)   <- swap its bank lane live
;; (generant/note "Bass Lane" 33) (generant/tempo 122) (generant/play)
;; type a quote or g and autocomplete offers your live synths + bank patterns
`;

function log(kind, text) {
  const line = document.createElement("div");
  line.className = `line ${kind}`;
  line.textContent = text;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

function setStatus(s, detail) {
  statusEl.textContent = detail ? `${s} · ${detail}` : s;
  statusEl.dataset.state = s;
  bootBtn.disabled = s === "booting" || s === "ready";
  bootBtn.textContent = s === "ready" ? "Booted" : s === "booting" ? "Booting…" : "Boot";
}

const engine = createEngine({ log, onStatus: setStatus });
setStatus("idle", "press Boot to start audio");

const generant = createGenerant();
engine.generant = generant; // (.-generant js/ovt) from Clojure
engine.editor = null; // set below once the CodeMirror view exists

let repl;
try {
  if (!globalThis.scittle?.core?.eval_string) throw new Error("scittle.js did not load");
  repl = createRepl({ scittle: globalThis.scittle, prelude, bridge: engine });
  log("info", "Clojure (SCI) ready. Try (help)");
} catch (e) {
  log("error", `could not start Clojure evaluator: ${e?.message ?? e}`);
}

// Buffers saved by the first slice are replaced once by the new example.
const saved = localStorage.getItem("ovt-buffer-v2");
const editor = createEditor({
  parent: host,
  initial: saved ?? SEED,
  onChange: (text) => localStorage.setItem("ovt-buffer-v2", text),
  getSnapshot: () => generant.snapshot(),
  onStop: () => {
    const r = repl?.evaluate("(stop)");
    log(r?.ok ? "info" : "error", r?.ok ? "stopped" : r?.value ?? "evaluator not ready");
  },
  onEval: () => evalNow(),
});
engine.editor = editor; // console/debug access: ovt.editor.view is the CM6 EditorView

let generantState = generant.snapshot();
async function generantRefresh(quiet) {
  try {
    generantState = await generant.refresh();
    log("info", `Generant: ${generantState.devices?.length ?? 0} devices, ${generantState.banks?.defs?.length ?? 0} banks @ ${generantState.bpm ?? "?"} bpm`);
    return generantState;
  } catch (e) {
    if (!quiet) log("error", e.message);
    return null;
  }
}

function evalNow() {
  if (!repl) return;
  const sel = editor.selection();
  const code = sel.from !== sel.to ? sel.text : editor.getValue();
  if (!code.trim()) return;
  log("input", code.trim().split("\n").filter((l) => !l.trim().startsWith(";")).join("\n") || code.trim());
  const r = repl.evaluate(code);
  log(r.ok ? "result" : "error", r.ok ? `=> ${r.value}` : r.value);
  r.promise?.then((pr) => log(pr.ok ? "result" : "error", pr.ok ? `=> ${pr.value}` : pr.value));
  editor.flash();
}

// Pull a Generant snapshot when the bridge namespace loads, so autocomplete
// offers live devices even before the first manual refresh.
const originalEvaluate = repl.evaluate.bind(repl);
repl.evaluate = (code) => {
  const r = originalEvaluate(code);
  if (/\(generant\/connect\b|\(generant\/refresh\b/.test(String(code))) generantRefresh(false);
  return r;
};

bootBtn.addEventListener("click", () => engine.boot());
evalBtn.addEventListener("click", evalNow);
$("clear").addEventListener("click", () => (out.textContent = ""));

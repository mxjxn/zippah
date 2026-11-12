import { PRELUDE as prelude } from "./prelude.js";
import { createEngine } from "./engine.js";
import { createRepl } from "./repl.js";
import "./style.css";

const $ = (id) => document.getElementById(id);
const editor = $("editor");
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
editor.value = saved ?? SEED;
editor.addEventListener("input", () => localStorage.setItem("ovt-buffer-v2", editor.value));

function evalNow() {
  if (!repl) return;
  const { selectionStart: a, selectionEnd: b, value } = editor;
  const code = a !== b ? value.slice(a, b) : value;
  if (!code.trim()) return;
  log("input", code.trim().split("\n").filter((l) => !l.trim().startsWith(";")).join("\n") || code.trim());
  const r = repl.evaluate(code);
  log(r.ok ? "result" : "error", r.ok ? `=> ${r.value}` : r.value);
  r.promise?.then((pr) => log(pr.ok ? "result" : "error", pr.ok ? `=> ${pr.value}` : pr.value));
  editor.classList.add("flash");
  setTimeout(() => editor.classList.remove("flash"), 150);
}

// init() is only ever reached from this click handler.
bootBtn.addEventListener("click", () => engine.boot());
evalBtn.addEventListener("click", evalNow);
editor.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    evalNow();
  } else if ((e.metaKey || e.ctrlKey) && e.key === ".") {
    e.preventDefault();
    const r = repl?.evaluate("(stop)");
    log(r?.ok ? "info" : "error", r?.ok ? "stopped" : r?.value ?? "evaluator not ready");
  }
});
$("clear").addEventListener("click", () => (out.textContent = ""));

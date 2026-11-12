// Headless test harness: real Scittle (SCI) + the real prelude + the real
// engine wrapper, with SuperSonic replaced by a recording fake and timers
// replaced by a manual clock. No audio.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { SuperSonic } from "supersonic-scsynth";
import { createEngine } from "../src/engine.js";
import { createRepl } from "../src/repl.js";
import { decodeSynthDefs } from "../src/synthdef.js";

const root = new URL("..", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
export const osc = SuperSonic.osc;
export const PRELUDE = ["core", "ugens", "synth", "time", "pattern"].map((n) => [n, read(`src/clj/${n}.cljs`)]);

export function makeWorld({ boot = true, refuse = [] } = {}) {
  const clock = { ms: 3913056000000 }; // engine NTP clock in ms
  const timers = [];
  let tid = 0;
  const fakeTimers = {
    set(f, ms) { const t = { id: ++tid, due: clock.ms + ms, f }; timers.push(t); return t.id; },
    clear(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  const sent = []; // {at, msg} | {at, bundle:{timeTag, packets}, raw}
  const defs = new Map();
  const logs = [];
  let nodeId = 1000;
  const sonic = {
    mode: "postMessage",
    audioContext: { sampleRate: 48000 },
    clock: { now: () => clock.ms / 1000 },
    on() {},
    async init() {},
    send: (...msg) => sent.push({ at: clock.ms, msg }),
    sendOSC: (raw) => sent.push({ at: clock.ms, bundle: osc.decode(raw), raw }),
    async loadSynthDef(src) {
      if (typeof src === "string") { defs.set(src, null); return { name: src, size: 0 }; }
      const [d] = decodeSynthDefs(src);
      const bad = d.ugens.find((u) => refuse.includes(u.name));
      if (bad) throw new Error(`UGen '${bad.name}' not installed.`);
      defs.set(d.name, d);
      return { name: d.name, size: src.length };
    },
    async purge() { sent.push({ at: clock.ms, purge: true }); },
    nextNodeId: () => nodeId++,
    getTree: () => ({ root: { id: 0, children: [] } }),
    async loadSample(bufnum, file) {
      return { bufnum, numFrames: 44100, numChannels: file.startsWith("loop") ? 2 : 1, sampleRate: 44100, duration: 1 };
    },
  };
  const engine = createEngine({
    log: (k, t) => logs.push([k, t]),
    makeSonic: () => sonic,
    timers: fakeTimers,
    preload: ["sonic-pi-prophet"],
  });

  const sandbox = { console, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.document = { addEventListener() {}, readyState: "loading", querySelectorAll: () => [] };
  vm.createContext(sandbox);
  vm.runInContext(read("public/vendor/scittle.js"), sandbox);
  sandbox.ovt = engine;
  const quiet = console.error;
  console.error = () => {}; // scittle prints its own error banners
  const repl = createRepl({ scittle: sandbox.scittle, prelude: PRELUDE, bridge: engine });
  console.error = quiet;

  const ev = (code) => {
    const q = console.error; console.error = () => {};
    try { return repl.evaluate(code); } finally { console.error = q; }
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  async function advance(ms, step = 5) {
    const end = clock.ms + ms;
    while (clock.ms < end) {
      clock.ms = Math.min(end, clock.ms + step);
      timers.sort((a, b) => a.due - b.due);
      while (timers.length && timers[0].due <= clock.ms) {
        const t = timers.shift();
        t.f();
        await flush();
      }
    }
    await flush();
  }
  const world = { clock, timers, sent, defs, logs, engine, repl, ev, flush, advance, sandbox };
  world.ready = boot ? engine.boot().then(() => world) : Promise.resolve(world);
  return world;
}

let failures = 0;
export function check(label, cond, detail) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${!cond && detail !== undefined ? "  " + detail : ""}`);
  if (!cond) failures++;
}
export function done() {
  console.log(failures ? `\n${failures} failing` : "\nall checks passed");
  process.exitCode = failures ? 1 : 0;
}

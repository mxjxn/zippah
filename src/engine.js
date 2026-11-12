// SuperSonic wiring + the JS half of the language runtime.
//
// - init() is ONLY called from boot(), which the page only calls from the
//   Boot button's click handler (user gesture).
// - Timing: every timed message goes to the engine as an OSC bundle with an
//   NTP timetag (SuperSonic.osc.encodeBundle + sendOSC); the engine's own
//   scheduler plays it sample-accurately. JS timers (setTimeout) are only
//   used to *wake up ahead of time* (lookahead) so loops can send their next
//   bundles; no sound is ever triggered by a timer firing.
import { SuperSonic } from "supersonic-scsynth";
import { encodeSynthDef } from "./synthdef.js";

// Loaded right after boot so the first-slice examples play immediately.
export const DEFAULT_SYNTHDEFS = [
  "sonic-pi-prophet",
  "sonic-pi-beep",
  "sonic-pi-tb303",
  "sonic-pi-pluck",
  "sonic-pi-piano",
  "sonic-pi-sc808_bassdrum",
  "sonic-pi-sc808_snare",
  "sonic-pi-sc808_closed_hihat",
];

const ROOT_GROUP = 0;
export const LOOKAHEAD_MS = 300; // how early loops wake to send the next bundle

const defaultMakeSonic = () => {
  // Asset URLs are served from public/ (see scripts/copy-assets.mjs).
  const origin = window.location.origin;
  return new SuperSonic({
    mode: "postMessage", // no SharedArrayBuffer / COOP+COEP needed
    workerBaseURL: `${origin}/supersonic/workers/`,
    coreBaseURL: `${origin}/supersonic-core/`,
    wasmBaseURL: `${origin}/supersonic-core/wasm/`,
    synthdefBaseURL: `${origin}/supersonic-synthdefs/`,
    sampleBaseURL: `${origin}/supersonic-samples/`,
  });
};

export function createEngine({
  log = () => {},
  onStatus = () => {},
  makeSonic = defaultMakeSonic,
  osc = SuperSonic.osc,
  timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) },
  preload = DEFAULT_SYNTHDEFS,
} = {}) {
  let sonic = null;
  let status = "idle"; // idle | booting | ready | error
  const loaded = new Set(); // synthdef names the engine has
  const pending = new Map(); // name -> Promise (loading)
  const compiled = new Map(); // name -> Uint8Array (our own defsynths)
  const bundles = []; // stack of open (at ...) bundles: {time, packets, deps}
  const liveTimers = new Set();
  let generation = 0; // bumps on stop(); stale async sends are dropped
  let nextBuf = 0;
  // Debug/verification: recent bundles we sent and node start events the
  // engine reported (/n_go via /notify). Small rings, newest last.
  const recentBundles = [];
  const nodeEvents = [];
  const ring = (arr, x, n = 200) => { arr.push(x); if (arr.length > n) arr.shift(); };

  const setStatus = (s, detail) => {
    status = s;
    onStatus(s, detail);
  };

  const requireReady = () => {
    if (status !== "ready") {
      throw new Error(
        status === "booting"
          ? "engine is still booting, try again in a moment"
          : "engine not booted - press Boot first (browsers only start audio from a click)"
      );
    }
  };

  async function boot() {
    if (status === "ready" || status === "booting") return status;
    setStatus("booting");
    try {
      sonic ??= makeSonic();
      sonic.on("error", (e) => log("error", `[engine] ${e?.message ?? e}`));
      sonic.on("in", (msg) => {
        if (msg?.[0] === "/fail") {
          const text = msg.slice(1).join(" ");
          const hint = /not installed/.test(text) ? " - that ugen is not built into SuperSonic, so this synth cannot load" : "";
          log("error", `[scsynth] /fail ${text}${hint}`);
        }
        else if (msg?.[0] === "/n_go" || msg?.[0] === "/n_end")
          ring(nodeEvents, { ev: msg[0], id: msg[1], at: sonic.clock.now() * 1000 });
      });
      await sonic.init();
      sonic.send("/notify", 1); // ask for /n_go and /n_end
      setStatus("ready", `mode: ${sonic.mode}`);
      log("info", `engine ready (${sonic.mode} transport, ${sonic.audioContext?.sampleRate ?? "?"} Hz)`);
      await Promise.all(preload.map((n) => loadSynthDef(n).catch(() => {})));
      if (preload.length) log("info", `loaded synthdefs: ${preload.filter((n) => loaded.has(n)).map((n) => n.replace("sonic-pi-", "")).join(" ")}`);
      // defsynths evaluated before boot
      const early = [...compiled.keys()];
      await Promise.all(early.map((n) => loadCompiled(n).catch(() => {})));
      if (early.length) log("info", `loaded defsynths: ${early.join(" ")}`);
    } catch (e) {
      setStatus("error", e?.message ?? String(e));
      log("error", `boot failed: ${e?.message ?? e}`);
    }
    return status;
  }

  function track(name, p) {
    const q = p.then(
      () => { loaded.add(name); pending.delete(name); return name; },
      (e) => { pending.delete(name); throw e; }
    );
    pending.set(name, q);
    q.catch(() => {});
    return q;
  }

  // Shipped synthdefs by name (fetched from synthdefBaseURL).
  function loadSynthDef(name) {
    requireReady();
    if (compiled.has(name)) return loadCompiled(name);
    if (loaded.has(name)) return Promise.resolve(name);
    if (pending.has(name)) return pending.get(name);
    return track(name, sonic.loadSynthDef(name).catch((e) => {
      log("error", `could not load synthdef ${name}: ${e?.message ?? e}`);
      throw e;
    }));
  }

  // Our own compiled defs: always (re)send the bytes (/d_recv semantics).
  function loadCompiled(name) {
    requireReady();
    const bytes = compiled.get(name);
    const prev = pending.get(name) ?? Promise.resolve();
    return track(name, prev.catch(() => {}).then(() => sonic.loadSynthDef(bytes)).catch((e) => {
      loaded.delete(name);
      log("error", `engine refused synthdef ${name}: ${e?.message ?? e}`);
      throw e;
    }));
  }

  function compileSynthDef(graph) {
    return encodeSynthDef(graph);
  }

  // Register a compiled def; load it now if booted, otherwise at boot.
  function defineSynth(name, bytes) {
    compiled.set(name, bytes);
    loaded.delete(name);
    if (status === "ready") return loadCompiled(name);
    return Promise.resolve(name);
  }

  // Make sure every def a message needs is loaded (or loading).
  function ensure(names) {
    const waits = [];
    for (const n of names) {
      if (pending.has(n)) waits.push(pending.get(n));
      else if (!loaded.has(n)) waits.push(loadSynthDef(n));
    }
    return waits;
  }

  function transmit(packets, time, deps) {
    const gen = generation;
    const go = () => {
      if (gen !== generation) return; // (stop) happened meanwhile
      if (time == null) {
        for (const p of packets) sonic.send(...p);
      } else {
        sonic.sendOSC(osc.encodeBundle(time / 1000, packets));
        ring(recentBundles, { time, sentAt: sonic.clock.now() * 1000, packets: packets.map((p) => p.slice(0, 16)) });
      }
    };
    const waits = ensure(deps);
    if (waits.length) Promise.all(waits).then(go, () => {});
    else go();
  }

  // Route a message: into the open (at ...) bundle, or straight out.
  function dispatch(packet, deps = []) {
    requireReady();
    const top = bundles[bundles.length - 1];
    if (top) {
      top.packets.push(packet);
      top.deps.push(...deps);
    } else {
      transmit([packet], null, deps);
    }
  }

  function send(address, args = []) {
    dispatch([address, ...args]);
  }

  // /s_new with an id we own, so the node can be ctl'd / killed later.
  function sNew(name, params = [], addAction = 0, target = ROOT_GROUP) {
    requireReady();
    const id = sonic.nextNodeId();
    dispatch(["/s_new", name, id, addAction, target, ...params], [name]);
    return id;
  }

  // immediate = bypass any open (at ...) bundle (used for definst groups)
  function newGroup(addAction = 0, target = ROOT_GROUP, immediate = false) {
    requireReady();
    const id = sonic.nextNodeId();
    if (immediate) sonic.send("/g_new", id, addAction, target);
    else dispatch(["/g_new", id, addAction, target]);
    return id;
  }

  // ---- time -------------------------------------------------------------
  // Times are milliseconds on the engine's NTP clock (clock.now() * 1000).
  function now() {
    requireReady();
    return sonic.clock.now() * 1000;
  }

  function beginAt(timeMs) {
    requireReady();
    if (typeof timeMs !== "number" || !Number.isFinite(timeMs)) throw new Error(`at: time must be a number of ms, got ${timeMs}`);
    bundles.push({ time: timeMs, packets: [], deps: [] });
  }

  function endAt() {
    const b = bundles.pop();
    if (b && b.packets.length) transmit(b.packets, b.time, b.deps);
  }

  function abortAt() {
    bundles.pop();
  }

  // Call f (no sound by itself) at wall time ~timeMs on the engine clock.
  function callAt(timeMs, f) {
    requireReady();
    const delay = Math.max(0, timeMs - now());
    const gen = generation;
    const t = timers.set(() => {
      liveTimers.delete(t);
      if (gen !== generation) return;
      try {
        f();
      } catch (e) {
        log("error", `scheduled fn failed: ${e?.message ?? e}`);
      }
    }, delay);
    liveTimers.add(t);
    return t;
  }

  async function stop() {
    requireReady();
    generation++;
    for (const t of liveTimers) timers.clear(t);
    liveTimers.clear();
    bundles.length = 0;
    // Silence now, then drop everything the engine is holding.
    sonic.send("/g_deepFree", ROOT_GROUP);
    try {
      await sonic.purge();
    } catch {}
    sonic.send("/clearSched");
    sonic.send("/g_deepFree", ROOT_GROUP);
  }

  // ---- buffers / samples ---------------------------------------------
  async function loadSample(path) {
    requireReady();
    const bufnum = nextBuf++;
    const file = /\.[a-z0-9]+$/i.test(path) || path.includes("/") ? path : `${path}.flac`;
    const r = await sonic.loadSample(bufnum, file);
    return { id: bufnum, frames: r.numFrames, channels: r.numChannels, rate: r.sampleRate, duration: r.duration, source: file };
  }

  return {
    boot,
    status: () => status,
    loadSynthDef,
    loadedSynthDefs: () => [...loaded],
    compileSynthDef,
    defineSynth,
    send,
    sNew,
    newGroup,
    stop,
    now,
    beginAt,
    endAt,
    abortAt,
    callAt,
    lookahead: () => LOOKAHEAD_MS,
    inBundle: () => bundles.length > 0,
    pendingTimers: () => liveTimers.size,
    loadSample,
    tree: () => (requireReady(), sonic.getTree()),
    nextNodeId: () => (requireReady(), sonic.nextNodeId()),
    log: (kind, text) => log(kind, text),
    recentBundles: () => recentBundles.slice(),
    nodeEvents: () => nodeEvents.slice(),
  };
}

// npm test: synthdef format, compiler, scheduler, and language surface.
import { readFileSync } from "node:fs";
import { makeWorld, check, done, osc } from "./harness.mjs";
import { encodeSynthDef, decodeSynthDefs } from "../src/synthdef.js";
import { patternTests } from "./patterns.mjs";

const hex = (b) => Buffer.from(b).toString("hex");
const lastSent = (w, pred = () => true) => [...w.sent].reverse().find(pred);
const bundles = (w) => w.sent.filter((s) => s.bundle);

// ---------------------------------------------------------------- format
{
  // Out.ar(0, SinOsc.ar(440)) encoded by hand from the SynthDef v2 spec.
  const graph = {
    name: "a",
    params: [],
    ugens: [
      { id: 1, name: "SinOsc", rate: 2, special: 0, numOutputs: 1, inputs: [{ constant: 440 }, { constant: 0 }] },
      { id: 2, name: "Out", rate: 2, special: 0, numOutputs: 0, inputs: [{ constant: 0 }, { ugen: 1, output: 0 }] },
    ],
  };
  const expected =
    "53436766" + "00000002" + "0001" + // SCgf, v2, 1 def
    "0161" + // "a"
    "00000002" + "43dc0000" + "00000000" + // 2 constants: 440, 0
    "00000000" + "00000000" + // 0 params, 0 names
    "00000002" + // 2 ugens
    "0653696e4f736302" + "00000002" + "00000001" + "0000" + "ffffffff00000000" + "ffffffff00000001" + "02" +
    "034f757402" + "00000002" + "00000000" + "0000" + "ffffffff00000001" + "0000000000000000" +
    "0000"; // variants
  check("encoder: Out.ar(0, SinOsc.ar(440)) matches hand-built SCgf v2 bytes", hex(encodeSynthDef(graph)) === expected, hex(encodeSynthDef(graph)));

  const [d] = decodeSynthDefs(encodeSynthDef(graph));
  check("decoder round-trip: names, constants, wiring", d.name === "a" && d.constants.join() === "440,0" &&
    d.ugens[1].inputs[1].join() === "0,0" && d.ugens[0].outputs.join() === "2");

  // Decoder sanity against Sonic Pi's shipped synthdefs (written by Overtone/SC).
  const pi = new Uint8Array(readFileSync(new URL("../node_modules/supersonic-scsynth-synthdefs/synthdefs/sonic-pi-prophet.scsyndef", import.meta.url)));
  const [p] = decodeSynthDefs(pi);
  check("decoder reads a shipped Sonic Pi synthdef", p.name === "sonic-pi-prophet" && p.ugens.length > 10, p.name);

  let threw = false;
  try { encodeSynthDef({ name: "x", ugens: [{ id: 1, name: "Out", rate: 2, numOutputs: 0, inputs: [{ constant: NaN }] }] }); } catch { threw = true; }
  check("encoder rejects NaN constants", threw);
}

// --------------------------------------------------------------- compiler
{
  const w = await makeWorld().ready;
  let r = w.ev("(defsynth bass [note 40 amp 0.3 cutoff 1200] (* amp (env-gen (perc 0.01 0.4) :action FREE) (rlpf (saw (midicps note)) cutoff 0.3)))");
  check("defsynth evaluates", r.ok, r.value);
  await w.flush(); await w.flush();
  const d = w.defs.get("bass");
  check("defsynth is sent to the engine as bytes (/d_recv via loadSynthDef)", !!d);
  check("params become one kr Control with defaults", d.ugens[0].name === "Control" && d.ugens[0].rate === 1 &&
    d.paramNames.map((p) => p.name).join() === "note,amp,cutoff" && d.params.map((x) => +x.toFixed(2)).join() === "40,0.3,1200");
  const names = d.ugens.map((u) => u.name);
  check("graph has EnvGen, midicps UnaryOp, Saw, RLPF, BinaryOps, Out", ["EnvGen", "UnaryOpUGen", "Saw", "RLPF", "BinaryOpUGen", "Out"].every((n) => names.includes(n)), names.join(" "));
  const topo = d.ugens.every((u, i) => u.inputs.every(([src, idx]) => src === -1 ? idx < d.constants.length : src < i));
  check("every ugen reads only constants or earlier ugens (topological)", topo);
  const env = d.ugens.find((u) => u.name === "EnvGen");
  const envVals = env.inputs.map(([s, i]) => (s === -1 ? +d.constants[i].toFixed(3) : "u"));
  check("perc envelope data: doneAction 2, [0 2 -99 -99 1 .01 5 -4 0 .4 5 -4]",
    envVals.slice(4).join() === "2,0,2,-99,-99,1,0.01,5,-4,0,0.4,5,-4", envVals.join());
  const out = d.ugens.find((u) => u.name === "Out");
  check("mono body is auto-wrapped as (out 0 [sig sig])", out.inputs.length === 3);

  r = w.ev("(bass 43)");
  await w.flush();
  const s = lastSent(w, (x) => x.msg?.[0] === "/s_new");
  check("calling the synth -> /s_new bass id 0 0 note 43", r.ok && s.msg.join() === `/s_new,bass,${r.value},0,0,note,43`, JSON.stringify(s?.msg));
  r = w.ev("(def id (bass :cutoff 900 :note 45))");
  await w.flush();
  check("kwargs keep written order", lastSent(w, (x) => x.msg?.[0] === "/s_new").msg.slice(5).join() === "cutoff,900,note,45");
  r = w.ev("(ctl id :cutoff 300)");
  check("ctl on a defsynth node -> /n_set", r.ok && lastSent(w).msg.slice(0, 1).concat(lastSent(w).msg.slice(2)).join() === "/n_set,cutoff,300", JSON.stringify(lastSent(w).msg));
  r = w.ev("(bass :nope 1)");
  check("unknown param is a clear error", !r.ok && /no param nope/.test(r.value), r.value);

  r = w.ev("(demo 1.5 (* 0.2 (lpf (saw [110 111]) (line:kr 200 4000 1.5))))");
  await w.flush(); await w.flush();
  const demoName = [...w.defs.keys()].find((k) => k.startsWith("ovt-demo"));
  const dd = w.defs.get(demoName);
  check("demo compiles, loads, then /s_new", r.ok && dd && lastSent(w, (x) => x.msg?.[0] === "/s_new").msg[1] === demoName, r.value);
  const line = dd.ugens.filter((u) => u.name === "Line" && u.rate === 1).at(-1);
  check("demo frees itself: Line.kr(0,0,dur,FREE)", line && dd.constants[line.inputs[2][1]] === 1.5 && dd.constants[line.inputs[3][1]] === 2);
  check("demo stereo graph: 2 Saw, 2 LPF (multichannel expansion)", dd.ugens.filter((u) => u.name === "Saw").length === 2 && dd.ugens.filter((u) => u.name === "LPF").length === 2);

  r = w.ev("(demo (pan2 (sin-osc 330) (sin-osc:kr 0.5)))");
  check("demo with pan2 + kr modulation", r.ok, r.value);
  r = w.ev("(definst wob [note 36 rate 2] (* 0.3 (lpf (saw (midicps note)) (+ 300 (* 2000 (lf-tri:kr rate))))))");
  check("definst evaluates", r.ok, r.value);
  r = w.ev("(wob 36)");
  await w.flush();
  const g = w.sent.find((x) => x.msg?.[0] === "/g_new");
  const sn = lastSent(w, (x) => x.msg?.[0] === "/s_new");
  check("definst notes go into the instrument's group", g && sn.msg[4] === g.msg[1] && sn.msg[3] === 0);
  w.ev("(ctl wob :rate 8)");
  check("(ctl inst ...) sets every note via the group", lastSent(w).msg.join() === `/n_set,${g.msg[1]},rate,8`);
  w.ev("(kill wob)");
  check("(kill inst) frees the group's notes", lastSent(w).msg.join() === `/g_freeAll,${g.msg[1]}`);

  r = w.ev("(defsynth fx [bus 16] (replace-out 0 (free-verb (in bus 2) 0.4 0.8)))");
  check("explicit out is not wrapped again", r.ok && w.ev("(:ugens (synth-def fx))").value.split("Out").length === 2, w.ev("(:ugens (synth-def fx))").value);
  r = w.ev("(let [b (audio-bus 2) g (group)] [b g])");
  check("audio-bus and group", r.ok && /^\[16 \d+\]$/.test(r.value), r.value);
  r = w.ev("(fx [:tail 0] :bus 16)");
  await w.flush(); await w.flush();
  check("placement vector [:tail target]", lastSent(w, (x) => x.msg?.[0] === "/s_new").msg.slice(3, 5).join() === "1,0");

  r = w.ev("(sin-osc 440)");
  check("ugen outside a synth: clear error", !r.ok && /inside defsynth/.test(r.value), r.value);
  r = w.ev("(demo (lpf))");
  check("missing required input: clear error", !r.ok && /lpf needs :in/.test(r.value), r.value);
  r = w.ev("(demo (sin-osc 440 :frq 2))");
  check("unknown ugen arg: clear error", !r.ok && /no arg :frq/.test(r.value), r.value);
  r = w.ev("(demo (mouse-x))");
  check("unsupported ugen: clear error", !r.ok && /not available in SuperSonic/.test(r.value), r.value);
  r = w.ev("(demo 42)");
  check("non-ugen body: clear error", !r.ok && /must return a ugen/.test(r.value), r.value);
  r = w.ev("(+ 1 2)");
  check("evaluator still alive after errors", r.ok && r.value === "3");

  // every ugen x rate compiles
  w.ev(readFileSync(new URL("./ugen-check.cljs", import.meta.url), "utf8"));
  r = w.ev("(count (ugen-test-defs))");
  check(`every exposed ugen/rate compiles (${r.value} defs)`, r.ok && +r.value > 100, r.value);

  // SuperSonic refusing a ugen surfaces as an error, not a crash
  const w2 = await makeWorld({ refuse: ["SinOsc"] }).ready;
  w2.ev("(defsynth nope [] (sin-osc 440))");
  await w2.flush(); await w2.flush();
  check("engine /fail on load is reported", w2.logs.some(([k, t]) => k === "error" && /refused synthdef nope/.test(t)), JSON.stringify(w2.logs));

  // before boot
  const w3 = makeWorld({ boot: false });
  r = w3.ev("(defsynth early [f 220] (sin-osc f))");
  check("defsynth before Boot compiles (queued)", r.ok, r.value);
  r = w3.ev("(early)");
  check("playing before Boot: clear error", !r.ok && /press Boot/.test(r.value), r.value);
  r = w3.ev("(demo (sin-osc 440))");
  check("demo before Boot: clear error", !r.ok && /press Boot/.test(r.value), r.value);
  await w3.engine.boot(); await w3.flush();
  check("queued defsynths load on Boot", w3.defs.has("early"));
}

// -------------------------------------------------------------- scheduler
{
  const w = await makeWorld().ready;
  w.ev("(defsynth beep [note 60] (* 0.2 (env-gen (perc 0.01 0.2) :action FREE) (sin-osc (midicps note))))");
  await w.flush(); await w.flush();
  const t0 = w.clock.ms;
  let r = w.ev("(at (+ (now) 500) (beep 64) (beep 67))");
  await w.flush();
  const b = bundles(w).at(-1);
  check("(at t ...) sends ONE bundle with both /s_new", r.ok && b?.bundle.packets.length === 2 && b.bundle.packets.every((p) => p[0] === "/s_new"));
  const tt = osc.readTimetag(b.raw);
  const want = (t0 + 500) / 1000;
  check("bundle timetag = engine NTP time + 0.5s (seconds + 2^32 fraction)",
    tt.ntpSeconds === Math.floor(want) && Math.abs(tt.ntpFraction / 2 ** 32 - (want % 1)) < 1e-6, JSON.stringify(tt));
  check("bundle was sent immediately, not by a timer", b.at === t0);
  r = w.ev("(after 250 (beep 70))");
  await w.flush();
  check("(after ms ...) = at now+ms", Math.abs(bundles(w).at(-1).bundle.timeTag * 1000 - (t0 + 250)) < 0.01);

  r = w.ev("(def m (metro 120)) [(m 0) (m 4) (m)]");
  const [b0, b4, nb] = JSON.parse(r.value.replace(/ /g, ","));
  check("metro: beat 0 = first use + lookahead, 120bpm = 500ms/beat", Math.abs(b0 - (w.clock.ms + 300)) < 0.01 && Math.abs(b4 - b0 - 2000) < 0.01 && nb === 0, r.value);

  const before = bundles(w).length;
  r = w.ev("(beat-loop :b m 0.5 (fn [b] (beep (+ 60 (* 2 b)))))");
  check("beat-loop starts", r.ok, r.value);
  await w.advance(2100);
  const loopB = bundles(w).slice(before);
  const tags = loopB.map((x) => x.bundle.timeTag * 1000);
  const gaps = tags.slice(1).map((t, i) => +(t - tags[i]).toFixed(3));
  check("beat-loop: one bundle per half beat, 250ms apart on the engine clock", loopB.length >= 8 && gaps.every((g) => g === 250), `${loopB.length} ${gaps}`);
  check("beat-loop: each bundle is sent ~lookahead before its time", loopB.every((x) => x.bundle.timeTag * 1000 - x.at >= 250 - 10), JSON.stringify(loopB.map((x) => x.bundle.timeTag * 1000 - x.at)));
  check("beat-loop: first hit on beat 0 = (m 0)", Math.abs(tags[0] - b0) < 0.01);

  r = w.ev("(beat-loop :b m 0.5 (fn [b] (beep 90)))");
  await w.advance(1000);
  check("re-evaluating beat-loop swaps the fn in place", r.value === "[:updated :b]" && bundles(w).at(-1).bundle.packets[0].slice(-1)[0] === 90);

  w.ev("(m :bpm 240)");
  const n1 = bundles(w).length;
  await w.advance(1000);
  const tg = bundles(w).slice(n1).map((x) => x.bundle.timeTag * 1000);
  check("tempo change: 240bpm -> 125ms steps", tg.slice(2).map((t, i) => +(t - tg[i + 1]).toFixed(3)).every((g) => g === 125), tg.join());

  r = w.ev("(seq-loop :s m 1 [40 nil 43] (fn [n] (beep n)))");
  await w.advance(1500);
  const seqNotes = bundles(w).filter((x) => x.bundle.packets.some((p) => p.includes(40) || p.includes(43))).map((x) => x.bundle.packets[0].at(-1));
  check("seq-loop plays the pattern with rests", seqNotes.length >= 2 && seqNotes.every((n) => n === 40 || n === 43), seqNotes.join());

  r = w.ev("(stop)");
  await w.flush(); await w.flush();
  const tail = w.sent.slice(-4).map((x) => (x.purge ? "purge" : x.msg?.join(" ")));
  check("(stop) -> /g_deepFree 0, purge(), /clearSched, /g_deepFree 0", tail.join("|") === "/g_deepFree 0|purge|/clearSched|/g_deepFree 0", tail.join("|"));
  check("(stop) cancels all pending loop timers", w.engine.pendingTimers() === 0 && w.ev("(running-loops)").value === "[]");
  const n2 = bundles(w).length;
  await w.advance(2000);
  check("nothing is sent after (stop)", bundles(w).length === n2);

  // a loop whose fn throws stops itself and reports
  w.ev("(beat-loop :bad m (fn [b] (when (= b (+ 2 (m 0) 0)) nil) (when (> b 1) (throw (ex-info \"boom\" {}))) (beep 60)))");
  await w.advance(3000);
  check("a failing loop stops itself and logs the error", w.logs.some(([k, t]) => k === "error" && /loop :bad stopped/.test(t)) && w.ev("(running-loops)").value === "[]");

  // samples
  r = w.ev("(load-sample :bd_haus)");
  const sb = await r.promise;
  check("load-sample resolves to a buffer", sb.ok && /:ovt\/type :buffer/.test(sb.value), sb.value);
  r = w.ev("(sample :bd_haus :rate 0.5)");
  await w.flush(); await w.flush();
  check("sample plays via ovt-sample-1 with the buffer id", r.ok && lastSent(w, (x) => x.msg?.[0] === "/s_new").msg.slice(1, 2).concat(lastSent(w, (x) => x.msg?.[0] === "/s_new").msg.slice(5)).join() === "ovt-sample-1,buf,0,rate,0.5", JSON.stringify(lastSent(w, (x) => x.msg?.[0] === "/s_new").msg));

  // first slice regressions
  r = w.ev("(play :prophet {:note 28 :release 8 :cutoff 70})");
  await w.flush();
  check("first slice: (play :prophet {...}) still works", lastSent(w, (x) => x.msg?.[0] === "/s_new").msg.slice(5).join() === "note,28,release,8,cutoff,70");
  r = w.ev("(at (+ (now) 100) (play :prophet {:note 40}))");
  await w.flush();
  check("Sonic Pi synths can be scheduled with at too", bundles(w).at(-1).bundle.packets[0][1] === "sonic-pi-prophet");
  r = w.ev("[(note :c4) (midicps 69) (hz->midi 440) (chord :c4 :major) (count (scale :c3 :minor))]");
  check("note / midicps / hz->midi / chord / scale", r.value === "[60 440 69 [60 64 67] 8]", r.value);
}

// --------------------------------------------------------------- patterns
await patternTests();

done();

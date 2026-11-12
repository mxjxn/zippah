// Pattern library tests (headless). Imported by test/run.mjs.
import { makeWorld, check } from "./harness.mjs";

const bundles = (w) => w.sent.filter((s) => s.bundle);
const sNews = (b) => b.bundle.packets.filter((p) => p[0] === "/s_new");
const param = (pkt, k) => { const i = pkt.indexOf(k, 5); return i < 0 ? undefined : pkt[i + 1]; };
const vals = (w, code) => { const r = w.ev(code); if (!r.ok) throw new Error(`${code}: ${r.value}`); return r.value; };

export async function patternTests() {
  const w = await makeWorld().ready;

  // --- streams -----------------------------------------------------------
  check("stream next / next-n / end is nil", vals(w, "(let [s (as-stream (pseq [1 2 3]))] [(next s) (next-n s 5) (next s)])") === "[1 [2 3] nil]");
  check("reset rewinds", vals(w, "(let [s (as-stream (pseq [1 2 3]))] (next s) (next s) (reset s) (next-n s 3))") === "[1 2 3]");
  check("constants are infinite patterns", vals(w, "(next-n (as-stream 7) 4)") === "[7 7 7 7]");
  check("nil constant is a rest stream", vals(w, "(next-n (as-stream nil) 2)") === "[:rest :rest]");
  check("next still works on seqs", vals(w, "(next [1 2 3])") === "(2 3)");

  // --- value patterns ----------------------------------------------------------
  check("pseq repeats + offset", vals(w, "(next-n (as-stream (pseq [1 2 3] 2 1)) 10)") === "[2 3 1 2 3 1]");
  check("pseq :inf", vals(w, "(count (next-n (as-stream (pseq [1 2] :inf)) 100))") === "100");
  check("pseq nil is a rest, nested patterns embed", vals(w, "(next-n (as-stream (pseq [1 nil (pseq [7 8] 2) 3])) 20)") === "[1 :rest 7 8 7 8 3]");
  check("pseq empty list ends at once", vals(w, "(next-n (as-stream (pseq [] :inf)) 3)") === "[]");
  let r = vals(w, "(next-n (as-stream (prand [1 2 3] 300)) 400)");
  let xs = JSON.parse(r.replace(/ /g, ","));
  check("prand: repeats values, all from the list", xs.length === 300 && xs.every((x) => [1, 2, 3].includes(x)) && new Set(xs).size === 3);
  xs = JSON.parse(vals(w, "(next-n (as-stream (pxrand [1 2 3] 500)) 500)").replace(/ /g, ","));
  check("pxrand: never the same item twice in a row", xs.length === 500 && xs.every((x, i) => i === 0 || x !== xs[i - 1]) && new Set(xs).size === 3);
  check("pxrand with one distinct item still yields", vals(w, "(next-n (as-stream (pxrand [5 5] 3)) 3)") === "[5 5 5]");
  r = vals(w, "(let [v (next-n (as-stream (pshuf [1 2 3 4 5] 3)) 20)] [(count v) (= (subvec v 0 5) (subvec v 5 10) (subvec v 10 15)) (sort (subvec v 0 5))])");
  check("pshuf: one shuffled order, repeated", r === "[15 true (1 2 3 4 5)]", r);
  r = vals(w, "[(set (next-n (as-stream (pwrand [:a :b] [1 0] 50)) 50)) (let [v (next-n (as-stream (pwrand [:a :b] [3 1] 4000)) 4000)] (/ (count (filter #{:a} v)) 4000))]");
  const frac = +r.split(" ").at(-1).replace("]", "");
  check("pwrand: zero weight never chosen; 3:1 weights ~75%", r.startsWith("[#{:a}") && frac > 0.7 && frac < 0.8, r);
  check("pseries", vals(w, "(next-n (as-stream (pseries 0 2 5)) 9)") === "[0 2 4 6 8]");
  check("pgeom", vals(w, "(next-n (as-stream (pgeom 1 2 5)) 9)") === "[1 2 4 8 16]");
  xs = JSON.parse(vals(w, "(next-n (as-stream (pwhite 1 3 600)) 600)").replace(/ /g, ","));
  check("pwhite: inclusive whole numbers for whole bounds", xs.length === 600 && new Set(xs).size === 3 && xs.every((x) => x >= 1 && x <= 3 && Number.isInteger(x)));
  xs = JSON.parse(vals(w, "(next-n (as-stream (pwhite 0 1 200 :float)) 200)").replace(/ /g, ","));
  check("pwhite :float and pwhite 0.25..0.5 give floats in range", xs.every((x) => x >= 0 && x <= 1) && xs.some((x) => !Number.isInteger(x)) &&
    JSON.parse(vals(w, "(next-n (as-stream (pwhite 0.25 0.5 50)) 50)").replace(/ /g, ",")).every((x) => x >= 0.25 && x <= 0.5));
  xs = JSON.parse(vals(w, "(next-n (as-stream (pexprand 100 1000 300)) 300)").replace(/ /g, ","));
  check("pexprand: in range, skewed low (median < arithmetic mid)", xs.every((x) => x >= 100 && x <= 1000) && xs.sort((a, b) => a - b)[150] < 550);
  check("pn repeats a whole pattern", vals(w, "(next-n (as-stream (pn (pseq [1 2]) 3)) 10)") === "[1 2 1 2 1 2]");
  check("pn :inf of an empty pattern ends instead of hanging", vals(w, "(next-n (as-stream (pn (pseq []) :inf)) 3)") === "[]");
  check("pdup with a number", vals(w, "(next-n (as-stream (pdup 2 (pseq [1 2]))) 9)") === "[1 1 2 2]");
  check("pdup with a pattern count", vals(w, "(next-n (as-stream (pdup (pseq [1 3]) (pseq [:a :b]))) 9)") === "[:a :b :b :b]");
  check("pfunc calls f each time; nil ends", vals(w, "(let [c (atom 0)] (next-n (as-stream (pfunc #(when (< @c 3) (swap! c inc)))) 9))") === "[1 2 3]");
  check("finite vs :inf: pwhite length", vals(w, "[(count (next-n (as-stream (pwhite 0 9 4)) 10)) (count (next-n (as-stream (pwhite 0 9 :inf)) 10))]") === "[4 10]");

  // --- math ----------------------------------------------------------------
  check("p+ pattern + number", vals(w, "(next-n (as-stream (p+ (pseq [0 2 4] :inf) 40)) 4)") === "[40 42 44 40]");
  check("p- / p* two patterns, shortest ends", vals(w, "[(next-n (as-stream (p- (pseq [10 20 30]) (pseq [1 2]))) 5) (next-n (as-stream (p* 2 (pseq [1 2 3]))) 5)]") === "[[9 18] [2 4 6]]");
  check("p+ keeps rests and is variadic", vals(w, "(next-n (as-stream (p+ (pseq [1 nil 3]) 10 100)) 5)") === "[111 :rest 113]");
  check("ugen + is untouched", vals(w, "(+ 1 2)") === "3");

  // --- pbind -----------------------------------------------------------------
  r = vals(w, "(next-n (as-stream (pbind :note (pseq [40 nil 43]) :dur 0.5 :amp (pseq [0.1 0.2] :inf))) 9)");
  check("pbind assembles events, stops when any stream ends", r === "[{:note 40, :dur 0.5, :amp 0.1} {:note :rest, :dur 0.5, :amp 0.2} {:note 43, :dur 0.5, :amp 0.1}]", r);
  check("pbind ends with its shortest key", vals(w, "(count (next-n (as-stream (pbind :note (pseq [1 2 3] :inf) :amp (pseq [1 1]))) 9))") === "2");
  check("event-rest?", vals(w, "[(event-rest? {:note :rest}) (event-rest? {:note 40}) (event-rest? {:type :rest :note 1})]") === "[true false true]");

  // --- players ------------------------------------------------------------
  w.ev("(defsynth pb [note 40 amp 0.3 cutoff 900] (* amp (env-gen (perc 0.01 0.2) :action FREE) (rlpf (saw (midicps note)) cutoff 0.3)))");
  await w.flush(); await w.flush();
  w.ev("(def m (metro 120))");
  const beat0 = +vals(w, "(m 0)");
  await w.advance(1300); // now ~beat 2 of the grid
  const beatMs = (b) => beat0 + b * 500;
  const n0 = bundles(w).length;
  r = vals(w, "(pdef :bass (pbind :instrument pb :note (pseq [40 nil 43 :c4] :inf) :dur 0.5 :amp 0.25 :bogus 1) {:metro m :quant 4})");
  check("pdef starts", r === "[:started :bass]", r);
  await w.advance(2600);
  let bs = bundles(w).slice(n0);
  check("quant 4: first event lands on beat 4 (a bar boundary)", Math.abs(bs[0]?.bundle.timeTag * 1000 - beatMs(4)) < 0.01, bs[0] && (bs[0].bundle.timeTag * 1000 - beat0) / 500);
  let times = bs.map((b) => (b.bundle.timeTag * 1000 - beat0) / 500);
  check("events every 0.5 beat, rest leaves a gap", times.slice(0, 4).join() === "4,5,5.5,6", times.join());
  let pk = sNews(bs[0])[0];
  check("event params: note/amp passed, unknown keys ignored for a defsynth", pk[1] === "pb" && param(pk, "note") === 40 && param(pk, "amp") === 0.25 && param(pk, "bogus") === undefined, JSON.stringify(pk));
  check("keyword :note -> MIDI", param(sNews(bs[2])[0], "note") === 60);
  check("each event is sent ~lookahead before its time", bs.every((b) => b.bundle.timeTag * 1000 - b.at >= 250));

  // swap without quant: next event uses the new pattern, grid unchanged
  const n1 = bundles(w).length;
  r = vals(w, "(pdef :bass (pbind :instrument pb :note (pseq [70] :inf) :dur 0.5))");
  await w.advance(1200);
  bs = bundles(w).slice(n1);
  times = bs.map((b) => (b.bundle.timeTag * 1000 - beat0) / 500);
  check("pdef swap: next event already uses the new pattern", r === "[:updated :bass]" && param(sNews(bs[0])[0], "note") === 70, JSON.stringify(bs.map((b) => param(sNews(b)[0], "note"))));
  check("pdef swap keeps the beat grid (half-beat steps continue)", times.every((t) => Number.isInteger(t * 2)) && times.slice(1).every((t, i) => t - times[i] === 0.5), times.join());

  // swap with quant: old pattern until the boundary, new from it
  const n2 = bundles(w).length;
  r = vals(w, "(pdef :bass (pbind :instrument pb :note (pseq [80] :inf) :dur 1) {:quant 4})");
  const at = +r.match(/:at-beat ([\d.]+)/)[1];
  await w.advance(3500);
  bs = bundles(w).slice(n2);
  const seq = bs.map((b) => [(b.bundle.timeTag * 1000 - beat0) / 500, param(sNews(b)[0], "note")]);
  const firstNew = seq.find(([, n]) => n === 80);
  check("pdef swap with :quant: new pattern starts exactly on the boundary", at % 4 === 0 && firstNew[0] === at && seq.filter(([t]) => t < at).every(([, n]) => n === 70), JSON.stringify(seq));

  // tempo change: still spaced in beats
  w.ev("(m :bpm 240)");
  const n3 = bundles(w).length;
  await w.advance(1200);
  const tt = bundles(w).slice(n3).map((b) => b.bundle.timeTag * 1000);
  check("tempo change: dur 1 beat at 240 bpm = 250 ms", tt.length >= 3 && tt.slice(2).every((t, i) => Math.abs(t - tt[i + 1] - 250) < 0.01), tt.slice(1).map((t, i) => t - tt[i]).join());

  // pstop
  r = vals(w, "(pstop :bass)");
  const n4 = bundles(w).length;
  await w.advance(1500);
  check("pstop: nothing sent afterwards", r === "[:stopped :bass]" && bundles(w).length === n4 && vals(w, "(running-pdefs)") === "[]");

  // pplay + chords + Sonic Pi instrument + midinote mapping + finite end
  w.ev("(m :bpm 120)");
  r = vals(w, "(def h (pplay (pbind :instrument :prophet :midinote (pseq [[60 64 67] 62]) :dur 1) {:metro m}))");
  await w.advance(2500);
  const pp = bundles(w).slice(n4);
  check("pplay: chord = several /s_new in one bundle; :midinote -> note for Sonic Pi", sNews(pp[0]).length === 3 && sNews(pp[0])[0][1] === "sonic-pi-prophet" && param(sNews(pp[0])[2], "note") === 67, JSON.stringify(pp[0]?.bundle.packets));
  check("finite pattern ends the player by itself", pp.length === 2 && vals(w, "(running-pdefs)") === "[]");
  r = vals(w, "(let [p (pplay (pbind :note 60 :dur 0.5) {:metro m})] (pstop p))");
  check("pstop takes a pplay handle", /:stopped :pplay-\d+/.test(r), r);

  // samples in events
  w.ev("(load-sample :bd_haus)");
  await w.flush(); await w.flush();
  const n5 = bundles(w).length;
  w.ev("(pdef :drum (pbind :sample :bd_haus :dur 1 :amp 0.5) {:metro m})");
  await w.advance(1200);
  const sp = sNews(bundles(w).slice(n5)[0] ?? { bundle: { packets: [] } })[0];
  check(":sample key plays a Sonic Pi sample", sp?.[1] === "ovt-sample-1" && param(sp, "amp") === 0.5, JSON.stringify(sp));

  // (stop) cancels players + loops
  w.ev("(pdef :a (pbind :note (pseq [60 62] :inf) :dur 0.25) {:metro m})");
  w.ev("(beat-loop :k m (fn [b] (pb 30)))");
  await w.advance(600);
  w.ev("(stop)");
  await w.flush(); await w.flush();
  const n6 = bundles(w).length;
  await w.advance(2000);
  check("(stop) cancels pdefs, pplays and loops: nothing sent afterwards", bundles(w).length === n6 && w.engine.pendingTimers() === 0 && vals(w, "(running-pdefs)") === "[]");

  // error in a player
  w.ev("(pdef :bad (pbind :note (pfunc #(throw (ex-info \"kaboom\" {}))) :dur 1) {:metro m})");
  await w.advance(800);
  check("a throwing pdef stops itself and logs id + beat", w.logs.some(([k, t]) => k === "error" && /pdef :bad stopped at beat [\d.]+: kaboom/.test(t)) && vals(w, "(running-pdefs)") === "[]");
  w.ev("(pdef :bad2 (pbind :note 60 :dur 0) {:metro m})");
  await w.advance(800);
  check("bad :dur is a clear error", w.logs.some(([k, t]) => /pdef :bad2 .*:dur must be a positive number/.test(t)));

  // beat-loop / seq-loop quant
  const n7 = bundles(w).length;
  r = vals(w, "(beat-loop :q m (fn [b] (pb 50)) {:quant 4 :phase 1})");
  await w.advance(3000);
  const q = bundles(w).slice(n7).map((b) => (b.bundle.timeTag * 1000 - +vals(w, "(m 0)")) / 500);
  check("beat-loop {:quant 4 :phase 1}: starts on a bar + 1 beat", r === "[:started :q]" && q[0] % 4 === 1 && q.slice(1).every((t, i) => t - q[i] === 1), q.join());
  w.ev("(stop-loop :q)");
  const n8 = bundles(w).length;
  r = vals(w, "(seq-loop :sq m 0.5 [40 nil 43] (fn [n] (pb n)) {:quant 4})");
  await w.advance(3000);
  const sq = bundles(w).slice(n8).map((b) => (b.bundle.timeTag * 1000 - +vals(w, "(m 0)")) / 500);
  check("seq-loop takes {:quant 4}", sq[0] % 4 === 0, sq.join());
  r = w.ev("(beat-loop :bad m (fn [b] nil) {:quant -1})");
  check("bad :quant is a clear error", !r.ok && /:quant must be a positive/.test(r.value), r.value);
  w.ev("(stop)");
}

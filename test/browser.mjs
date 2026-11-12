// Headless Chrome check against the running dev server (npm run dev).
// CHROME=/path/to/chrome node test/browser.mjs  [URL]
// Verifies boot, the real engine accepting every compiled ugen, demo,
// defsynth, engine-side timing of bundles (/n_go), stop, samples, the seed.
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const URL_ = process.argv[2] ?? "http://localhost:5173/";
const exe = process.env.CHROME ?? "/usr/bin/google-chrome";
let fails = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail !== undefined ? "  " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
  if (!cond) fails++;
};

let browser;
try {
  browser = await chromium.launch({ executablePath: exe, args: ["--autoplay-policy=no-user-gesture-required"] });
} catch (e) {
  console.log(`SKIPPED: could not launch Chrome (${e.message.split("\n")[0]}). The headless suite (npm test) is the gate.`);
  process.exit(0);
}
const page = await browser.newPage();
const http = [];
page.on("response", (r) => { if (r.status() >= 400) http.push(`${r.status()} ${r.url()}`); });
page.on("pageerror", (e) => http.push(`pageerror ${e.message}`));
await page.goto(URL_);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForTimeout(500);

const lines = () => page.$$eval("#output .line", (ls) => ls.map((l) => [l.className.replace("line ", ""), l.textContent]));
async function ev(code, wait = 150) {
  const before = (await lines()).length;
  await page.fill("#editor", code);
  await page.click("#eval");
  await page.waitForTimeout(wait);
  return (await lines()).slice(before).filter(([k]) => k !== "input");
}
const engineNow = () => page.evaluate(() => window.ovt.now());
const treeNames = () => page.evaluate(() => {
  const out = [];
  const walk = (n) => { if (n.type === "synth") out.push(n.defName); (n.children || []).forEach(walk); };
  walk(window.ovt.tree().root);
  return out;
});

let r = await ev("(demo (sin-osc 440))");
check("eval before Boot: clear error", r.some(([k, t]) => k === "error" && /press Boot/.test(t)), r);

await page.click("#boot");
await page.waitForFunction(() => document.getElementById("status").dataset.state === "ready", null, { timeout: 30000 });
await page.waitForTimeout(1500);
check("booted", true, await page.textContent("#status"));

// 1. Every ugen/rate the surface exposes, loaded into the real engine.
await ev(readFileSync(new URL("./ugen-check.cljs", import.meta.url), "utf8"));
r = await ev("(let [ds (ugen-test-defs)] (doseq [d ds] (register-synth d)) (count ds))", 4000);
const total = +r.find(([k]) => k === "result")?.[1].replace("=> ", "");
const refused = (await lines()).filter(([k, t]) => k === "error" && /refused synthdef t-|\/fail/.test(t)).map(([, t]) => t);
check(`real engine accepts all ${total} ugen/rate test synthdefs`, total > 100 && refused.length === 0, refused.slice(0, 10).join("\n"));

// 2. demo makes a node that frees itself after its duration
r = await ev("(demo 1 (* 0.2 (lpf (saw [110 111]) (line:kr 200 3000 1))))", 400);
let names = await treeNames();
check("demo: node is in the engine tree", names.some((n) => n.startsWith("ovt-demo")), names);
await page.waitForTimeout(1300);
names = await treeNames();
check("demo: node freed itself after 1s (Line FREE)", !names.some((n) => n.startsWith("ovt-demo")), names);

// 3. defsynth, call, ctl
r = await ev("(defsynth ping [note 72 amp 0.2] (* amp (env-gen (perc 0.005 0.3) :action FREE) (sin-osc (midicps note))))\n(defsynth drone [f 110 cutoff 800] (* 0.1 (rlpf (saw [f (* f 1.005)]) cutoff 0.3)))\n(def d (drone 55))", 500);
check("defsynth + call: no errors", !r.some(([k]) => k === "error"), r);
names = await treeNames();
check("defsynth node is running in the engine", names.includes("drone"), names);
r = await ev("(ctl d :cutoff 2000)");
check("ctl ok", r.some(([k, t]) => k === "result" && t === "=> :ok"), r);
r = await ev("(kill d)", 300);
check("kill frees it", !(await treeNames()).includes("drone"));

// 4. timing: a bundle 800ms ahead starts on the engine at that time, not on receipt
r = await ev("(def t-at (+ (now) 800)) (def pid (at t-at (ping 76)))", 50);
const ids = await page.evaluate(() => [window.ovt.recentBundles().at(-1)]);
await page.waitForTimeout(1200);
const timing = await page.evaluate(() => {
  const b = window.ovt.recentBundles().at(-1);
  const id = b.packets[0][2];
  const go = window.ovt.nodeEvents().find((e) => e.ev === "/n_go" && e.id === id);
  return { scheduled: b.time, sentAt: b.sentAt, nGoSeenAt: go?.at, id };
});
const lead = timing.scheduled - timing.sentAt;
const late = timing.nGoSeenAt - timing.scheduled;
check("at: bundle sent ~800ms early", lead > 700, { lead });
check("at: engine reported /n_go at the scheduled time (reply seen within 0..60ms after it)", timing.nGoSeenAt && late >= -5 && late < 60, { late, ...timing });

// 5. metro + beat-loop: bundles spaced exactly, nodes start on the grid
await ev("(def m (metro 240)) (beat-loop :p m 0.5 (fn [b] (ping (+ 72 (* 2 (mod (* 2 b) 4))) :amp 0.1)))", 50);
await page.waitForTimeout(2200);
const grid = await page.evaluate(() => {
  const bs = window.ovt.recentBundles().filter((b) => b.packets[0][1] === "ping").slice(-8);
  const ev = window.ovt.nodeEvents();
  return bs.map((b) => ({ t: b.time, lead: b.time - b.sentAt, go: ev.find((e) => e.ev === "/n_go" && e.id === b.packets[0][2])?.at }));
});
const gaps = grid.slice(1).map((g, i) => +(g.t - grid[i].t).toFixed(2));
check("beat-loop: bundles 125ms apart at 240bpm/half-beats", gaps.length >= 5 && gaps.every((g) => g === 125), gaps);
check("beat-loop: each sent >= 200ms ahead", grid.every((g) => g.lead > 200), grid.map((g) => Math.round(g.lead)));
const played = grid.filter((g) => g.go);
check("beat-loop: engine started each node on its timetag (<60ms reply latency)", played.length >= 4 && played.every((g) => g.go - g.t >= -5 && g.go - g.t < 60), played.map((g) => Math.round(g.go - g.t)));

// 6. stop cancels loops + far-future bundles + sounding nodes
await ev("(def far (at (+ (now) 1500) (ping 90))) (def dd (drone 40))", 100);
r = await ev("(stop)", 300);
check("(stop) ok", r.some(([k, t]) => t === "=> :stopped"), r);
const afterStop = await page.evaluate(() => window.ovt.recentBundles().length);
await page.waitForTimeout(1800);
const st = await page.evaluate((n) => {
  const bs = window.ovt.recentBundles();
  const lastFar = bs.filter((b) => b.packets[0][1] === "ping" && b.packets[0].length).at(-1);
  return { newBundles: bs.length - n, pending: window.ovt.pendingTimers() };
}, afterStop);
const farId = await page.evaluate(() => window.ovt.recentBundles().filter((b) => b.packets[0][1] === "ping").at(-1).packets[0][2]);
const farPlayed = await page.evaluate((id) => window.ovt.nodeEvents().some((e) => e.ev === "/n_go" && e.id === id), farId);
check("(stop): no loop bundles afterwards, no pending timers", st.newBundles === 0 && st.pending === 0, st);
check("(stop): a bundle scheduled 1.5s ahead never played (purge + /clearSched)", !farPlayed);
check("(stop): tree has no synths", (await treeNames()).length === 0, await treeNames());

// 6b. patterns: pdef on the real engine
await ev("(defsynth pb [note 60 amp 0.1] (* amp (env-gen (perc 0.005 0.15) :action FREE) (sin-osc (midicps note))))\n(def pm (metro 240))", 300);
r = await ev("(pdef :pt (pbind :instrument pb :note (pseq [72 nil 76 79] :inf) :dur 0.5) {:metro pm :quant 4})", 50);
check("pdef starts on the real engine", r.some(([k, t]) => t === "=> [:started :pt]"), r);
await page.waitForTimeout(2500);
const pg = await page.evaluate(() => {
  const bs = window.ovt.recentBundles().filter((b) => b.packets[0][1] === "pb").slice(-8);
  const ev = window.ovt.nodeEvents();
  return bs.map((b) => ({ t: b.time, lead: b.time - b.sentAt, note: b.packets[0].length, go: ev.find((e) => e.ev === "/n_go" && e.id === b.packets[0][2])?.at }));
});
const pgaps = pg.slice(1).map((g, i) => +(g.t - pg[i].t).toFixed(2));
check("pdef: events on the half-beat grid (125 ms steps, a rest = 250 ms gap)", pgaps.length >= 4 && pgaps.every((g) => g === 125 || g === 250) && pgaps.includes(250), pgaps);
const pplayed = pg.filter((g) => g.go);
check("pdef: engine started each event at its timetag (<60ms reply latency)", pplayed.length >= 4 && pplayed.every((g) => g.go - g.t >= -5 && g.go - g.t < 60), pplayed.map((g) => Math.round(g.go - g.t)));
r = await ev("(pdef :pt (pbind :instrument pb :note 90 :dur 0.5))", 700);
const swapped = await page.evaluate(() => window.ovt.recentBundles().filter((b) => b.packets[0][1] === "pb").slice(-2).map((b) => b));
check("pdef live swap reaches the engine", r.some(([, t]) => t === "=> [:updated :pt]") && swapped.length === 2 && swapped.at(-1).packets[0].includes(90), [r, swapped.at(-1)?.packets[0]]);
await ev("(def far2 (at (+ (now) 1500) (pb 100)))", 50);
await ev("(stop)", 300);
const nb = await page.evaluate(() => window.ovt.recentBundles().length);
await page.waitForTimeout(1800);
const far2 = await page.evaluate(() => window.ovt.recentBundles().filter((b) => b.packets[0][1] === "pb").at(-1).packets[0][2]);
const after2 = await page.evaluate(([n, id]) => ({ newBundles: window.ovt.recentBundles().length - n, played: window.ovt.nodeEvents().some((e) => e.ev === "/n_go" && e.id === id) }), [nb, far2]);
check("(stop) cancels the pdef and a future event", after2.newBundles === 0 && !after2.played, after2);

// 7. samples
r = await ev("(sample :bd_haus)", 1500);
check("sample :bd_haus loads + plays", !r.some(([k]) => k === "error"), r);
r = await ev("(sample :loop_amen :rate 0.8)", 1500);
names = await treeNames();
check("stereo sample plays via ovt-sample-2", names.includes("ovt-sample-2"), names);
await ev("(stop)", 300);

// 8. the seeded example runs clean
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.click("#boot");
await page.waitForFunction(() => document.getElementById("status").dataset.state === "ready", null, { timeout: 30000 });
await page.waitForTimeout(1200);
const before = (await lines()).length;
await page.focus("#editor");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(2500);
const seedOut = (await lines()).slice(before);
names = await treeNames();
check("seed example: no errors", !seedOut.some(([k]) => k === "error"), seedOut);
check("seed example: demo + loops make nodes", names.length > 0, names);
await page.screenshot({ path: process.env.SHOT ?? "screenshots/overtone-supersonic-2.png" });
await page.keyboard.press("Control+.");
await page.waitForTimeout(500);
check("Ctrl-. stops", (await page.evaluate(() => window.ovt.pendingTimers())) === 0);

check("no HTTP errors / page errors", http.length === 0, http);
await browser.close();
console.log(fails ? `\n${fails} failing` : "\nall browser checks passed");
process.exitCode = fails ? 1 : 0;

// Audio listen-test pass: headed Chromium + sink-monitor recording.
// DISPLAY=:0 CHROME=/path/to/chrome node scripts/listen-pass.mjs  [URL]
// Requires the dev server (npm run dev). Records Mnemosyne's default sink
// monitor per step into audio/ and writes audio/timeline.json.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const URL_ = process.argv[2] ?? "http://localhost:5173/";
const exe = process.env.CHROME ?? "/usr/bin/google-chrome";
const MON = process.env.MONITOR ?? "alsa_output.pci-0000_12_00.3.analog-stereo.monitor";
const DIR = new URL("../audio/", import.meta.url).pathname;
const timeline = [];

function rec(name) {
  const p = spawn("pw-record", ["--target", MON, "--rate", "48000", "--channels", "2", "--format", "s16", DIR + name], { stdio: "ignore" });
  return {
    stop: async () => {
      process.kill(p.pid, "SIGINT");
      await new Promise((res) => p.on("exit", res));
    },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  browser = await chromium.launch({ executablePath: exe, headless: false, args: ["--autoplay-policy=no-user-gesture-required"] });
} catch (e) {
  console.log(`SKIPPED: could not launch Chrome (${e.message.split("\n")[0]})`);
  process.exit(0);
}
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
await page.goto(URL_);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.click("#boot");
await page.waitForFunction(() => document.getElementById("status").dataset.state === "ready", null, { timeout: 30000 });
await page.waitForTimeout(1500);
console.log("booted:", await page.textContent("#status"));

async function step(name, fn) {
  const r = rec(name + ".wav");
  await sleep(400);
  const t0 = Date.now();
  const out = await fn();
  await sleep(400);
  await r.stop();
  timeline.push({ step: name, wav: name + ".wav", startedAt: t0, evals: out });
  console.log(`recorded ${name}.wav`, JSON.stringify(out));
}

async function ev(code, wait = 250) {
  const before = await page.$$eval("#output .line", (ls) => ls.length);
  await page.fill("#editor", code);
  await page.click("#eval");
  await page.waitForTimeout(wait);
  const lines = await page.$$eval("#output .line", (ls, n) => ls.slice(n).map((l) => [l.className.replace("line ", ""), l.textContent]), before);
  timeline.push({ at: Date.now(), eval: code.split("\n")[0].slice(0, 60), lines });
  return lines;
}

const SEED = `(demo 3 (* 0.15 (rlpf (saw [110 110.6]) (line:kr 300 3000 3) 0.3)))

(defsynth pluck-bass [note 40 amp 0.35 cutoff 1400]
  (* amp (env-gen (perc 0.005 0.35) :action FREE)
     (rlpf (saw (midicps note)) cutoff 0.25)))

(def m (metro 118))
(seq-loop :bass m 0.5 [40 nil 40 43 nil 47 45 nil] (fn [n] (pluck-bass n)))
(beat-loop :kick m (fn [b] (play :sc808_bassdrum {:amp 1.5})))`;

// 1. seeded buffer: saw sweep + bass seq + kick on 118 bpm (14 s of loop)
await step("step1-seed", async () => {
  const o = [];
  o.push(...await ev(SEED, 400));
  await sleep(13500);
  o.push(...await ev("(stop-loop :bass) (stop-loop :kick)"));
  return o;
});

// 2+3. fresh synth, mono centered
await step("step2-sin440", async () => {
  const o = await ev("(demo (sin-osc 440))");
  await sleep(3800);
  return o;
});

// 4. ctl + kill
await step("step4-ctl-kill", async () => {
  const o = [];
  o.push(...await ev("(def nid (demo 30 (* 0.2 (saw 220))))"));
  await sleep(2000);
  o.push(...await ev("(ctl nid :freq 330)"));
  await sleep(2500);
  o.push(...await ev("(kill nid)"));
  await sleep(1500);
  return o;
});

// 5. pdef: quant 4 start, live swap (no opts = next event), pstop
await step("step5-pdef", async () => {
  const o = [];
  o.push(...await ev(`(pdef :lead (pbind :instrument pluck-bass
                   :note (p+ (pxrand [0 3 7 10 12] :inf) 64)
                   :dur (pseq [0.5 0.25 0.25] :inf)
                   :amp (pwhite 0.15 0.3 :inf :float)
                   :cutoff (pexprand 600 4000 :inf))
      {:metro m :quant 4})`));
  await sleep(7000);
  o.push(...await ev(`(pdef :lead (pbind :instrument pluck-bass
                   :note (p+ (pseq [0 12 0 -12] :inf) 64)
                   :dur 0.5 :amp 0.25 :cutoff 2500))`));
  await sleep(5000);
  o.push(...await ev("(pstop :lead)"));
  await sleep(2000);
  return o;
});

// 6. tempo change under a running loop
await step("step6-tempo", async () => {
  const o = [];
  o.push(...await ev("(beat-loop :kick m (fn [b] (play :sc808_bassdrum {:amp 1.5})))"));
  await sleep(4000);
  o.push(...await ev("(m :bpm 132)"));
  await sleep(4000);
  o.push(...await ev("(stop-loop :kick)"));
  await sleep(1200);
  return o;
});

// 7. bundled synth + sample
await step("step7-bundled", async () => {
  const o = [];
  o.push(...await ev("(play :prophet {:note 28 :release 8 :cutoff 70})"));
  await sleep(2000);
  o.push(...await ev("(sample :bd_haus)", 400));
  await sleep(2000);
  o.push(...await ev("(sample :bd_haus)", 400));
  await sleep(2500);
  return o;
});

// 8. pstop tail vs (stop)
await step("step8-stop", async () => {
  const o = [];
  o.push(...await ev("(stop)"));
  await sleep(1200);
  o.push(...await ev("(seq-loop :dense m 0.25 [64 67 71 74] (fn [n] (pluck-bass n :amp 0.4)))"));
  await sleep(3000);
  o.push(...await ev("(pstop :dense)"));
  await sleep(1500);
  o.push(...await ev("(seq-loop :dense2 m 0.25 [76 79 76 72] (fn [n] (pluck-bass n :amp 0.4)))"));
  await sleep(2500);
  o.push(...await ev("(stop)"));
  await sleep(1500);
  return o;
});

writeFileSync(DIR + "timeline.json", JSON.stringify(timeline, null, 2));
console.log("errors:", JSON.stringify(errors));
console.log("pending timers:", await page.evaluate(() => window.ovt.pendingTimers()), "tree:", await page.evaluate(() => window.ovt.tree().nodeCount));
await browser.close();

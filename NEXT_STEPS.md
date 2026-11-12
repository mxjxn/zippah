# Next steps

This is the first audio-test pass for [zippah](https://github.com/mxjxn/zippah), plus a list of what is still unbuilt.

The browser REPL, SynthDef compiler, ugens, metro/loops, and pattern library (`pbind`, `pdef`, and the value patterns) are on `main`. Headless tests and headless Chrome against SuperSonic 0.97.0 both passed, including node timing. Nothing has been heard yet: the machine that built this has no sound device. The next job is to pull this repo, listen, and write down what sounds wrong.

## Run it

```bash
git clone https://github.com/mxjxn/zippah.git
cd zippah
npm install
npm run dev
```

Open http://localhost:5173/ — localhost or HTTPS is required for AudioWorklet. Click **Boot**, then press **Cmd/Ctrl-Enter** to evaluate the buffer (or the selection). **Cmd/Ctrl-.** or `(stop)` silences everything.

```bash
npm test              # headless, no audio
npm run test:browser  # headless Chrome against a running dev server
```

SuperSonic samples and WASM assets are not in git. `npm install` and `npm run dev` copy them into `public/` from the npm packages.

## Listen for these

Do these in order. Note anything that sounds late, quiet, one-sided, clicky, or not like the form implies.

1. **The seeded buffer.** After Boot and Cmd-Enter you should hear a three-second filtered stereo saw (`rlpf` over a slightly detuned `saw`), then a `pluck-bass` sequence and an `sc808_bassdrum` kick on a 118 bpm metro.

2. **A new synth in the page.** Evaluate something like `(demo (sin-osc 440))` or a fresh `defsynth` that is not in the seed. This is the main unheard claim: `defsynth` compiles SynthDef bytes in the browser and loads them with `/d_recv`. No precompiled def is required.

3. **Mono is centered.** `(demo (sin-osc 440))` should come from both speakers. That is deliberate: unlike Overtone, a mono body is sent to both channels.

4. **`ctl` and `kill`.** Start a longer synth, change a param while it plays (`(ctl id :cutoff 800)` or similar), then `(kill id)`.

5. **Live patterns.** Uncomment the `pdef :lead` block in the seed, evaluate it, then edit a pattern (notes, `dur`, `cutoff`) and re-evaluate. The new pattern should take over on the next event, on the same beat grid. `(pstop :lead)` stops just that player.

6. **Quant and tempo.** `:quant 4` on a `pdef` or `beat-loop` should wait for the next 4-beat boundary before the first note. While things are running, `(m :bpm 132)` should speed up without losing the beat.

7. **Bundled sounds still work.** `(play :prophet {:note 28 :release 8 :cutoff 70})` and `(sample :bd_haus)` (or the seed kick) should play as before.

8. **Stop behavior.** `(pstop :lead)` or `(stop-loop :kick)` can leave up to about 300 ms of notes that were already sent. `(stop)` / Cmd-Ctrl-. should clear loops, patterns, and the scheduler, and silence everything.

## Known issues (not surprises)

- SuperSonic 0.97.0 cannot cancel a single already-sent bundle. Only `(stop)` clears the scheduler. This is an engine limit, not a typo in `pstop`.
- A hidden or background browser tab may stutter loops. Browsers throttle timers there; the fix is a Worker-based clock, which is not built yet.
- Ugen argument order follows SuperCollider's definitions and was checked against Sonic Pi synths and engine loads, not by ear for every ugen.
- If a synth uses a missing ugen, `loadSynthDef` may not reject its promise. Watch the output for the engine's `/fail` and a follow-up "SynthDef not found".
- The project is AGPL-3.0-or-later. Scittle/SCI is EPL-1.0, which is still an open compatibility question before any wider distribution.

## Not built yet

Leave these unless listening turns one of them into a blocker.

- Pattern layer: `ppar`, `pmono`, filter/stretch patterns (`padd`, `pstretch`, and friends), and SuperCollider's degree/scale event defaults.
- Routines / Tasks with `yield` / `wait`. Clojure has no good `yield`; `apply-by` and `pbind` are the current sequencing tools.
- Ugens left out for time, not because the engine refused them: `LocalIn` / `LocalOut`, `Klank`, demand-rate and FFT ugens, `SendReply` callbacks, trigger-rate params. Known-unsupported ones (`mouse-x`, `disk-in`, `onsets`) already error clearly.
- `definst` effect chains and `/n_map`.
- A Worker timer, so loops stay steady in a background tab.
- Strudel-like player UI (piano roll, shareable URLs). Not the immediate path.

## After you listen

The most useful report is what sounded wrong, with the form you evaluated and roughly what you heard. Timing, panning, levels, `ctl`, live `pdef` swaps, and the difference between `pstop` and `(stop)` matter most. Once that is in, we can pick the next language slice from the list above.

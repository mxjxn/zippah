# zippah

**Overtone REPL for the browser**

A zero-install browser page, shaped like Strudel. You type **Clojure** and hear **SuperSonic**, Sam Aaron's WASM
build of scsynth, which runs in an AudioWorklet. The language is an Overtone-flavoured surface evaluated by **SCI**
(through Scittle) in the page. It includes a real **SynthDef compiler**: `defsynth`, `demo`, and ~100 ugens become SynthDef
v2 bytes sent to the engine. It also has **sample-accurate timing**: `at`, `metro`, and live loops are timestamped OSC
bundles that the engine's own scheduler plays.

## Run it

```bash
npm install
npm run dev            # copies engine assets into public/, then starts Vite
# open http://localhost:5173/   (localhost or HTTPS is required for AudioWorklet)
```

1. Click **Boot**. The browser only starts audio from a click.
2. Press **Cmd/Ctrl-Enter**. That evaluates the selection if there is one, otherwise the whole buffer.
3. **Cmd/Ctrl-.** stops everything.

The buffer is saved in localStorage.

| script | what |
|---|---|
| `npm test` (= `npm run smoke`) | Headless test with no audio: real SCI, the real prelude, and the real engine wrapper, with SuperSonic faked. Covers SynthDef bytes, the compiler, OSC bundle timetags, loops, stop, and samples. |
| `npm run test:browser` | Headless Chrome against `npm run dev`. Boots the real engine, loads every ugen/rate into it, and checks that nodes appear/free, that `/n_go` arrives at bundle times, and that stop works. `CHROME=/path/to/chrome` if it isn't `/usr/bin/google-chrome`. |
| `npm run build` / `preview` | Static build in `dist/` (~41 MB, mostly Sonic Pi samples) |

## The language

The seeded buffer, which is what you hear first after Boot:

```clojure
(demo 3 (* 0.15 (rlpf (saw [110 110.6]) (line:kr 300 3000 3) 0.3)))

(defsynth pluck-bass [note 40 amp 0.35 cutoff 1400]
  (* amp (env-gen (perc 0.005 0.35) :action FREE)
     (rlpf (saw (midicps note)) cutoff 0.25)))

(def m (metro 118))
(seq-loop :bass m 0.5 [40 nil 40 43 nil 47 45 nil] (fn [n] (pluck-bass n)))
(beat-loop :kick m (fn [b] (play :sc808_bassdrum {:amp 1.5})))
;; try: (m :bpm 132)   (stop-loop :kick)   (help)   (stop)
```

### Synths

```clojure
(demo (sin-osc 440))                         ; 2 s, then frees itself
(demo 4 (pan2 (* 0.2 (saw 220)) (sin-osc:kr 0.5)))

(defsynth bass [note 40 amp 0.3] (* amp (env-gen (perc) :action FREE) (saw (midicps note))))
(bass 43)  (bass :note 45 :amp 0.2)  (bass {:note 47})    ; positional, kwargs or map -> node id
(def id (bass 40)) (ctl id :amp 0.1) (kill id)

(defsynth pad [note 52 gate 1]                       ; gated envelope: release with (ctl id :gate 0)
  (* 0.2 (env-gen (adsr 0.5 0.2 0.7 1.5) :gate gate :action FREE)
     (splay (saw (midicps [note (+ note 7) (+ note 12)])))))

(definst wob [note 36 rate 2] (* 0.3 (lpf (saw (midicps note)) (+ 300 (* 2000 (lf-tri:kr rate))))))
(wob) (wob 38) (ctl wob :rate 8) (kill wob)          ; definst = its own group: ctl/kill reach every note

(def s (synth [f 300] (* 0.1 (sin-osc f)))) (s 500)  ; anonymous
(defcgen fat [f] (mix (saw [f (* f 1.01) (* f 0.99)])))   ; helper with ugen math
```

- Overtone-style **multichannel expansion**: a vector input makes one ugen per channel, so `(saw [110 111])` is stereo.
- **Rates**: `name` is the default (usually `:ar`), and `name:kr` / `name:ar` / `name:ir` pick a rate.
- Ugen args are **positional or keyword** (`(rlpf sig :freq 800 :rq 0.2)`). `:action` (or `:done-action`) takes `FREE`,
  `NO-ACTION`, `PAUSE`, or `FREE-AND-BEFORE`.
- **Math on ugens**: inside `defsynth`/`synth`/`definst`/`demo`/`defcgen` bodies, `+ - * / min max mod abs pow sqrt exp floor
  < > rand` work on ugens and fold on plain numbers. Outside those bodies, use `u+ u- u* u-div umin umax`.
- A body with no `out` is wrapped in `(out 0 ...)`, and a mono signal is sent to both speakers. That's a deliberate change
  from Overtone, where mono goes left only. An explicit `out`/`replace-out`/`offset-out` is left alone.
- Params are one control-rate `Control` ugen with float defaults, so `ctl` (`/n_set`) works on any of them after spawn.
- Placement: `(bass [:tail g] 40)`, with `[:head|:tail|:before|:after|:replace target]`.
- Helpers: `midicps cpsmidi midi->hz hz->midi midiratio dbamp ampdb squared cubed tanh distort softclip reciprocal clip2
  absdif`, `mix splay lin-lin`, and the envelopes `perc adsr asr lin (lin-env) triangle envelope`.
- `(ugens)` lists the ugens and `(ugen-doc 'rlpf)` shows args, defaults, and rates.

**Ugens (100 names, 179 name×rate variants, all accepted by the real engine in the browser check):** sin-osc saw pulse lf-saw
lf-tri lf-par lf-cub lf-pulse var-saw sync-saw blip fsin-osc sin-osc-fb formant impulse dust dust2 lf-noise0 lf-noise1
lf-noise2 white-noise pink-noise brown-noise gray-noise clip-noise crackle · lpf hpf rlpf rhpf bpf brf resonz ringz moog-ff
one-pole leak-dc lag lag-ud decay decay2 · comb-n comb-l comb-c allpass-n allpass-c delay-n delay-l delay-c pluck free-verb
free-verb2 g-verb pitch-shift limiter normalizer · pan2 balance2 x-fade2 · line x-line env-gen linen phasor detect-silence
free-self done free-self-when-done · rand (`ugen-rand` outside bodies) exp-rand i-rand t-rand t-exp-rand latch trig trig1
toggle-ff pulse-count stepper select · clip wrap fold lin-exp mul-add k2a a2k dc · out replace-out offset-out in · play-buf
buf-rd buf-rate-scale buf-frames buf-dur · sample-rate sample-dur control-rate.

### Time

All times are **ms on the engine clock** (`(now)`).

```clojure
(at (+ (now) 500) (bass 40) (bass 47))     ; ONE OSC bundle, NTP timetag, scheduled inside the engine
(after 250 (bass 52))
(def m (metro 120))  (m) (m 16) (m :bpm 140) (metro-bpm m) (beat-ms m 4)
(beat-loop :kick m (fn [beat] (bass 36)))              ; every beat, at (m beat)
(beat-loop :hat m 0.25 (fn [b] (sample :drum_cymbal_closed :amp 0.3)))
(seq-loop :bass m 0.5 [40 nil 43 45] (fn [n] (bass n)))  ; nil = rest
;; re-evaluate a loop with the same id to swap its fn live (it keeps the beat)
(stop-loop :kick) (running-loops)
(apply-by (m 32) my-fn 32)   ; Overtone's temporal recursion: wakes 300 ms early so my-fn can (at (m 32) ...)
(stop)                       ; loops + pending timers + scheduled bundles + every sounding synth
```

How it works: `at` collects every message sent in its body into one bundle,
`SuperSonic.osc.encodeBundle(t/1000, packets)` → `sendOSC`. Loops use a JS timer only to wake up **300 ms before** each step
and send that step's bundle. The sound is placed by the engine's scheduler, never by the timer. `(stop)` bumps a generation
counter and clears every timer. It sends `/g_deepFree 0` immediately, then `purge()` (which drops scheduled bundles and
the IN ring), then `/clearSched`, and `/g_deepFree 0` again.

### Patterns (`pdef`, `pbind`, SC-style value patterns)

Patterns are stateless recipes. A **stream** is one cursor over a pattern. `nil` ends a stream, and a rest is the
keyword `:rest`: writing `nil` *inside* a list means a rest. Plain values act as infinite constant patterns, and a
pattern inside a list gets embedded. `repeats` can be a number or `:inf`.

```clojure
(def s (as-stream (pseq [1 2 3] 2)))   (next s) (next-n s 4) (reset s)
(pseq [0 3 7] :inf 1)        ; list, repeats, offset
(prand [0 3 7] 8) (pxrand [0 3 7] :inf) (pshuf [0 3 7] 2) (pwrand [0 7] [0.8 0.2] :inf)
(pseries 0 2 8) (pgeom 1 2 5) (pwhite 0 7 :inf) (pwhite 0.1 0.3 :inf :float) (pexprand 200 4000 :inf)
(pn (pseq [1 2]) 3) (pdup (pseq [2 1] :inf) (pseq [:a :b] :inf)) (pfunc #(rand-int 12))
(p+ (pseq [0 3 7] :inf) 60) (p- ...) (p* ...)   ; rests pass through; the ugen u+/u* math is untouched
```

`pbind` produces event maps and stops as soon as any key's stream ends.

```clojure
(def m (metro 118))
(pdef :lead (pbind :instrument pluck-bass            ; a defsynth/definst fn, or a Sonic Pi keyword (:prophet)
                   :note (p+ (pseq [0 3 nil 7] :inf) 40)  ; nil in the list = rest (no synth, still waits :dur)
                   :dur (pseq [0.5 0.25 0.25] :inf)  ; metro beats
                   :amp 0.3)                         ; every other key is a synth param
      {:metro m :quant 4 :phase 0})                  ; starts on the next 4-beat boundary
;; re-evaluate the same id to swap the pattern at the next event, keeping the grid:
(pdef :lead (pbind :instrument :tb303 :note 40 :dur 0.5))
(pdef :lead (pbind ...) {:quant 4})                  ; ...or wait for the next bar to swap
(pstop :lead) (running-pdefs)
(def h (pplay (pbind :note (pseq [60 64 67]) :dur 0.25) {:metro m}))  (pstop h)   ; anonymous, ends by itself
(beat-loop :kick m (fn [b] (bass 36)) {:quant 4})    ; loops take an optional trailing {:quant :phase}
(seq-loop :bass m 0.5 [40 nil 43] bass-fn {:quant 4 :phase 0.5})
(stop)                                               ; also cancels every pdef/pplay
```

Every event is sent as a timestamped bundle at `(m beat)`, using the same 300 ms lookahead as loops. If a player's
pattern throws, that player stops and logs the id and the beat. The others keep going.

Additions and deviations from SC/Overtone:

- **Rests:** `:rest` is the rest value (`(next s)` returns it). An event is a rest if `:type :rest` is set or any
  value is `:rest`.
- **`pwhite`:** whole-number bounds give integers. Pass `:float` as the 4th arg for floats, because JS can't tell `0`
  from `0.0`.
- **`:midinote`:** becomes `:note` unless the synth declares `midinote`.
- **`:note` values:** keyword notes (`:e2`) are converted, and a vector `:note` plays a chord.
- **`:sample` key:** `(pbind :sample (pseq [:bd_haus :sn_dolf]) :dur 1)` plays the sample.
- **Unknown keys:** for a defsynth, keys it doesn't declare are dropped. They aren't errors.
- **Defaults:** the instrument defaults to `:beep`. With no `:metro`, a shared 120 bpm metro is used. An update without
  `:metro` keeps the player's current metro.
- **Loops:** re-evaluating a loop with `:quant` swaps its fn as before. The quant applies only to its first start.
- **`play`:** the name is unchanged. Use `pdef`/`pplay`.

### Samples, buses, groups

```clojure
(sample :bd_haus) (sample :loop_amen :rate 0.8 :amp 0.7)    ; Sonic Pi samples (loads on first use)
(def b (load-sample :ambi_choir))  ; promise -> {:ovt/type :buffer :id .. :channels ..}
(sample-player buf :rate 0.5 :pan -0.3)
(defsynth slicer [buf 0] (play-buf 1 buf (buf-rate-scale:kr buf) 1 0 1))   ; buffers as plain ugen inputs
(def fx-bus (audio-bus 2)) (def g (group)) (group :tail g)
(defsynth verb [in-bus 16] (replace-out 0 (free-verb (in in-bus 2) 0.4 0.8)))
```

If `(sample ...)` is used inside `at` before the sample has loaded, that hit is skipped with a message and loading starts.

### First-slice forms (still work)

`(play :prophet {:note 28 :release 8 :cutoff 70})`, `(s-new "sonic-pi-beep" :note 72)`, `(load-synthdef :tb303)`,
`(synthdefs)`, `(tree)`, `(send "/n_set" id "amp" 0.2)`, `(note :e1)`, `(status)`, `(boot)`, `(help)`. Plus
`(scale :c3 :minor)` and `(chord :e3 :m7)`. Sonic Pi synths can be scheduled with `at` and used in loops.

## Errors

These all print in the output pane. None of them take down the page, the evaluator, or the engine:

- engine not booted
- ugen used outside a synth body
- missing or unknown ugen arg
- unknown synth param
- non-ugen synth body
- known-unsupported ugens (`mouse-x`, `disk-in`, `onsets`, … say why)
- compile failures
- the engine's own `/fail` (e.g. `UGen 'X' not installed`)

A loop whose fn throws stops itself and reports the beat it failed on.

## What is still missing

- **SuperCollider/Overtone surface not built:**
  - `LocalIn`/`LocalOut` feedback
  - `Klank`/`DynKlank` and other array-spec ugens beyond `select`
  - demand-rate ugens (`Dseq`…)
  - FFT/PV ugens (SuperSonic has them, but they aren't wrapped)
  - `SendReply`/`/tr`-driven callbacks
  - `:tr`/`:ar` param rates and lag'd controls
  - synthdef variants
  - Overtone's `defsynth` metadata (`:min`/`:max`)
  - `inst` FX chains (`inst-fx!`)
  - a volume/pan per inst
  - control-bus mapping (`/n_map`)
  - `(event)` hooks
  - Overtone's full `defcgen` syntax
  - `Ppar`, `Pmono`, `Padd`/`Pstretch`, `Routine`/`Task`
  - SC's event prototype (`:degree`/`:scale`/`:octave` → note, `:legato`/`:sustain` gating). Use `:note` with
    `scale` and an env in the synth instead.
  - per-pdef `cancelTag` stops (the ≤300 ms already sent still plays after `pstop`)
- `defsynth` params must have numeric defaults. `{:default n}` maps are accepted, but other keys are ignored.
- Out of scope for this chunk: CodeMirror, URL sharing, visualisations.

## SuperSonic gaps hit or checked

- Every ugen above was loaded into SuperSonic 0.97.0 in headless Chrome with no `/fail`. Documented as unavailable on the
  web build: `MouseX/Y`, `MouseButton`, `KeyState`, `DiskIn/Out`, `VDiskIn`, `LinkJump`, the Bela ugens, and
  `BeatTrack`/`Onsets`/`MFCC`/`KeyTrack`/`Loudness`/`Spec*`. Those have stubs that explain why.
- `/d_load` and `/d_loadDir` are refused on the web. Compiled defs go through `loadSynthDef(bytes)`, which is `/d_recv` with
  the bytes.
- `/clearSched` works in 0.97.0 (the reference says so). There's no `cancelTag`, so `(stop)` is all-or-nothing. A single
  loop is stopped client-side (`stop-loop`), and its ≤300 ms of already-sent bundles still play.
- When a def fails with `/fail`, `loadSynthDef` doesn't seem to reject. The `/fail` reply is what reports it. The
  following `/s_new` then fails with "SynthDef not found", and that's reported too.

## Pinned versions

| package | version | license |
|---|---|---|
| supersonic-scsynth (client) | 0.97.0 | AGPL-3.0-or-later |
| supersonic-scsynth-core (WASM engine + worklet) | 0.97.0 | AGPL-3.0-or-later |
| supersonic-scsynth-synthdefs (Sonic Pi synthdefs) | 0.97.0 | MIT |
| supersonic-scsynth-samples (Sonic Pi samples) | 0.97.0 | CC0-1.0 |
| scittle (SCI for the browser) | 0.8.33 | EPL-1.0 |
| vite (dev) | 8.3.8 | MIT |
| playwright-core (dev, browser test only) | 1.65.0 | Apache-2.0 |

**Transport: postMessage** (`mode: "postMessage"`). No SharedArrayBuffer, no COOP/COEP. SAB wasn't attempted, because
postMessage timing measured fine (below).

## How it's wired

- `src/clj/core.cljs`: first-slice forms (`play s-new ctl kill send note scale chord tree`)
- `src/clj/ugens.cljs`: graph builder, ugen table (`defugens`), operators, envelopes, unsupported stubs
- `src/clj/synth.cljs`: `synth defsynth definst demo defcgen`, spawning and placement, groups, buses, samples
- `src/clj/time.cljs`: `now at after apply-at apply-by metro quant-beat beat-loop seq-loop stop help`
- `src/clj/pattern.cljs`: streams, value patterns, `pbind`, players (`pdef pplay pstop`); extends `stop`/`help`
- `src/synthdef.js`: SynthDef v2 encoder (plus a v1/v2 decoder used by tests)
- `src/engine.js`: SuperSonic wrapper: boot, def loading and queueing, bundles, lookahead timers, stop, samples. It also
  keeps debug rings: `ovt.recentBundles()` and `ovt.nodeEvents()` (`/n_go`/`/n_end` via `/notify 1`).
- `src/repl.js`, `src/main.js`: SCI eval and the minimal UI
- `scripts/copy-assets.mjs`: copies workers, worklet, WASM, synthdefs, samples, and scittle into `public/` (git-ignored)

## Verification (on the build box, no speakers)

- `npm test`: all checks pass.
  - The encoder matches hand-built SCgf v2 bytes for `Out.ar(0, SinOsc.ar(440))`.
  - Compiled graphs are topologically ordered.
  - Envelope data and doneActions are correct.
  - `at` bundles carry the right NTP seconds and fraction.
  - Loop bundles are exactly one step apart and sent about 300 ms early.
  - Tempo changes work.
  - `(stop)` sends deepFree → purge → clearSched → deepFree and clears all timers, and nothing is sent afterwards.
  - The first-slice forms still behave.
  - Patterns (`test/patterns.mjs`):
    - streams: next/reset/next-n, plus every value pattern and its finite vs `:inf` repeats
    - rests, and `p+`/`p-`/`p*`
    - `pbind`: event assembly and stop-on-nil
    - `pdef`:
      - starts on a quant bar
      - an update swaps at the next event on the same grid
      - an update with `:quant` waits for the boundary
    - tempo changes respace events
    - nothing is sent after `pstop` or `(stop)`
    - a throwing player stops and logs its beat
- `npm run test:browser`: all checks pass against the real engine.
  - 179/179 ugen synthdefs load.
  - A `demo` node appears and frees itself after its duration.
  - A bundle scheduled 800 ms ahead reports `/n_go` 2 ms after its timetag.
  - Loop nodes start 0–8 ms after their timetags. That's reply latency; the bundles themselves are 125.00 ms apart.
  - `(stop)` stops a bundle 1.5 s in the future from ever playing.
  - A `pdef` on the real engine:
    - events land on a 125 ms grid, and rests leave 250 ms gaps
    - `/n_go` arrives -2 to +8 ms from each timetag
    - a live swap reaches the engine
    - `(stop)` cancels the pdef and a future event
  - Samples play.
  - The seed example runs with no errors.
  - There are no 404s.
- Audio itself wasn't heard: there's no sound device on the build box.

## Risks / leftovers

- **Timing**:
  - Bundles are sample-accurate inside the engine. The NTP float timetag carries about 1 µs of precision.
  - Loop *dispatch* depends on JS timers firing at least 300 ms early. Background tabs throttle timers to about 1 s, so
    loops will stutter or skip in a hidden tab. The fix is a Worker-based timer (SuperSonic supports OscChannel in
    workers).
  - Tempo changes apply to bundles not yet sent, so up to 300 ms of already-sent hits keep the old tempo.
- **Ugen args**: argument orders follow SuperCollider's class definitions. They were checked against input counts in Sonic
  Pi's compiled defs and with real engine loads, but not by ear for every ugen.
- `Pan2`/`Out` etc. get `K2A`/`DC` inserted for control-rate or constant inputs, which is SC behaviour. Filters at `:kr`
  are not converted.
- **License**: the project is AGPL-3.0-or-later. Scittle/SCI is EPL-1.0, and that's an unresolved compatibility question
  for anything published. Overtone (MIT) was used only as a reference, for operator indices and naming. No Overtone source
  was copied.
- **Bundling**:
  - `optimizeDeps.exclude` keeps SuperSonic's lazy chunks working.
  - `appType: "mpa"` keeps missing assets as real 404s.
  - The samples make `public/` and `dist/` about 41 MB.
  - Chrome still logs `ERR_ABORTED` for some asset fetches during boot. They load fine (seen in the first slice too).

## Licensing and relationships

This project is licensed **AGPL-3.0-or-later** (see `LICENSE`), because it combines SuperSonic and Clockwork. scsynth is
GPL-3.0-or-later, Clockwork is AGPL-3.0-or-later, and the combined program is AGPL-3.0-or-later.

- **SuperSonic** by Sam Aaron: the engine. https://github.com/samaaron/supersonic
- **Overtone** (MIT): the language this surface follows. Naming and the SC operator table come from it; no code was
  copied. https://github.com/overtone/overtone
- **Strudel** (AGPL-3.0): the product shape. No code was used. https://strudel.cc
- **Sonic Pi** synthdefs (MIT) and samples (CC0), through the SuperSonic packages.
- **SCI / Scittle** by Michiel Borkent (EPL-1.0). See the license note above.
- Prior art: Arne Brasseur's https://github.com/plexus/supersonic-cljs-demo (the idea only, no code).

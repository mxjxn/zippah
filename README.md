# zippah

Overtone in the browser. You type **Clojure**, and **SuperSonic** — Sam Aaron's WASM build of scsynth — plays it in an AudioWorklet. No Java, no install beyond `npm`.

See [NEXT_STEPS.md](NEXT_STEPS.md) for remaining work, and [LISTEN_REPORT.md](LISTEN_REPORT.md) for the first real-audio pass.

## Run it

```bash
git clone https://github.com/mxjxn/zippah.git
cd zippah
npm install
npm run dev
```

Open http://localhost:5173/ — localhost or HTTPS is required for AudioWorklet. Click **Boot**, then press **Cmd/Ctrl-Enter** to evaluate the buffer or the selection. **Cmd/Ctrl-.** or `(stop)` silences everything. The buffer is saved in localStorage.

```bash
npm test              # headless, no audio
npm run test:browser  # headless Chrome against a running dev server
```

## Play

This is the seeded buffer, and the first thing you hear after Boot:

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

The kick and bass can get a little hot where they land together; turn your output down a notch, or drop the kick to `{:amp 1.0}`.

A new synth is compiled in the page and loaded into the engine:

```clojure
(demo (sin-osc 440))

(defsynth bass [note 40 amp 0.3]
  (* amp (env-gen (perc) :action FREE) (saw (midicps note))))
(def id (bass 40))
(ctl id :amp 0.1)
(kill id)
```

Patterns are SuperCollider-style. Re-evaluate a `pdef` to swap it on the next event; add `{:quant 4}` if you want the swap to wait for the bar:

```clojure
(pdef :lead (pbind :instrument pluck-bass
                   :note (p+ (pxrand [0 3 7 10 12] :inf) 64)
                   :dur (pseq [0.5 0.25 0.25] :inf)
                   :amp (pwhite 0.15 0.3 :inf :float)
                   :cutoff (pexprand 600 4000 :inf))
      {:metro m :quant 4})
(pstop :lead)
```

Bundled Sonic Pi synths and samples:

```clojure
(play :prophet {:note 28 :release 8 :cutoff 70})
(sample :bd_haus)
(sample :loop_amen :rate 0.8 :amp 0.7)
```

Time lives on the engine clock, not in a JavaScript timer:

```clojure
(at (+ (now) 500) (bass 40) (bass 47))
(after 250 (bass 52))
(stop)
```

## A little more language

Vectors expand into channels, so `(saw [110 110.6])` is stereo. A mono signal is sent to both speakers — unlike Overtone, where mono goes left only. Inside a synth body, `+ - * /` work on ugens. `nil` in a sequence is a rest.

Use `(stop-loop id)` for a `beat-loop` or `seq-loop`, and `(pstop id)` for a `pdef`. They are not interchangeable: `(pstop)` will happily say it stopped a loop and then keep playing it.

`(help)` and `(ugens)` are there when you need them, and `(ugen-doc 'rlpf)` shows args.

## License

This project is **AGPL-3.0-or-later** (see `LICENSE`), because it includes [SuperSonic](https://github.com/samaaron/supersonic) 0.97.0. The language follows [Overtone](https://github.com/overtone/overtone) (MIT); naming and the operator table come from it, and no source was copied. The page is shaped like [Strudel](https://strudel.cc). Clojure is evaluated by [SCI / Scittle](https://github.com/babashka/scittle) 0.8.33 (EPL-1.0). Sonic Pi synthdefs (MIT) and samples (CC0) arrive through SuperSonic's packages.

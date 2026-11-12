# Listen pass — 2026-11-12 (Mnemosyne, real audio out)

First audio-test pass against SuperSonic 0.97.0 on real speakers, recorded from
the sink monitor and measured offline (see `audio/analyze.py`). Reproduce with
`DISPLAY=:0 CHROME=... node scripts/listen-pass.mjs` against a running dev
server; per-step recordings land in `audio/` with `audio/timeline.json`.

## Verdicts on the doc's eight steps

1. **Seeded buffer** — plays. Saw sweep, pluck-bass seq, and 808 kick all
   audible; kick period measured 510 ms vs the 508 ms nominal at 118 bpm.
   One issue: the mix is hot (see findings).
2. **New synth in the page** — works. `(demo (sin-osc 440))` on a fresh node:
   single 440 Hz spectral peak, no clicks (max sample jump 0.058).
3. **Mono centered** — confirmed. 440 Hz band RMS identical in L/R
   (−7.0 dBFS both, diff 0.00 dB).
4. **ctl / kill** — works on a defsynth param. `drone` at 220 Hz, `ctl :freq
   330` lands within ~0.5 s (220 → −100 dB, 330 → −27 dB), `kill` silences in
   ~0.3 s. Note: `ctl` on a `(demo …)` node is a silent no-op (see findings).
5. **Live patterns** — works. `:quant 4` start lands on the bar boundary
   (first note 1.16 s after eval, ≤ 1 bar); swap takes over on the next event
   (0.5/0.25/0.25 grid of 255/127 ms continues through the swap, then uniform
   255 ms under the new `:dur 0.5`); `pstop :lead` tail 260 ms ≤ ~300 ms.
6. **Quant and tempo** — works. `(m :bpm 132)` under a running loop: kick
   period 510 → 460 ms (nominal 508 → 455), no dropped beats across the change.
7. **Bundled sounds** — play. `:prophet` pad (note 28, release 8) rings ~4 s;
   both `:bd_haus` hits audible.
8. **Stop behavior** — `(stop)` gives true digital silence: 0.000000 RMS from
   ~400 ms after the eval to end of file; 0 pending timers, empty node tree.
   `pstop` on a pdef leaves the documented ≤ ~300 ms of already-sent notes.

## Findings (what sounded wrong)

1. **Seed mix clips near coincidence points.** Kick `:amp 1.5` + bass
   `:amp 0.35` sum toward full scale; the pre-fader monitor recording has
   ~85k clipped samples over 15 s (peak 1.000). At the test output volume
   (50 %) coincidences still land around −4.7 dBFS — any hotter output will
   distort. Suggest kick amp ~1.0 in the seed, or note the headroom.
2. **`(pstop <loop-id>)` is a silent no-op that reports success.** Loops live
   in a separate registry from pdefs (`@loops` vs `@players` in
   `time.cljs`/`pattern.cljs`); `pstop` only dissocs from `@players`, so
   `(pstop :dense)` on a `seq-loop` returns `[:stopped :dense]` while notes
   keep firing ~1.8 s longer in the recording. It should either stop loops or
   throw the same clear error style used elsewhere ("pdef: :quant must be…").
   Workaround until then: `(stop-loop id)` — and the two are not symmetric,
   which the doc's step 8 wording implies they are.
3. **`(ctl <demo-node> :param …)` returns `:ok` and does nothing.** `demo`
   compiles with an empty param list (`synth.cljs` line ~148), so `/n_set`
   targets a param that doesn't exist. `ctl` already rejects defsynth *names*
   with a clear error; node ids from `demo` deserve the same. Test with a
   `defsynth` param instead — that path is solid (verdict 4 above).

## Known issues confirmed/unaffected

- Background-tab throttling not exercised (Worker clock unbuilt, as
  documented).
- Missing-ugen `/fail` behavior not exercised this pass.
- Headless Chromium emits no audio; audio passes need a headed browser
  (`listen-pass.mjs` launches one on `DISPLAY=:0`).

# leyzah — visual live-coding for zippah

**Status:** Phase 0 design (docs only). No implementation in this PR.  
**Audience:** zippah maintainers deciding how visuals plug into the existing REPL, clock, and pattern system.

## What it is

**leyzah** (Boston-accent “laser”; also a nod to Clojure lazy sequences, as zippah nods to zippers) is a browser visual live-coding library that lives **inside** zippah. You type the same Clojure buffer you already use for sound; visuals render full-bleed behind the editor. There is no second app and no second editor.

Hard constraints (same as zippah):

- Plain browser — no Java, no sclang, no Electron requirement for the core path.
- Do not copy Overtone, SuperCollider, or Hydra source. Behaviour and naming may be inspired by them; the code is written fresh under zippah’s license.

## How it sits in zippah today

zippah today (observed on `main`):

| Piece | Role | Touch points for leyzah |
| --- | --- | --- |
| SCI / Scittle REPL | Evaluate Clojure forms into `user` (plus `generant`) | New forms (`out`, `scene`, `lfo`, `defscene`, `bind`, `on`, …) registered like patterns/time |
| `metro` / `at` / `apply-by` | Musical time on the SuperSonic engine NTP clock; JS timers only wake lookahead | Visual signals and cues schedule against **the same** metro and engine time |
| `pbind` / `pdef` / value patterns | Event streams on a beat grid; live swap; optional `:quant` bar boundary | New event key `:emit` announces visual events; `on` / `cue` can wait for pattern start / quant |
| CodeMirror editor + Strudel-shaped chrome | One buffer, Cmd/Ctrl-Enter eval, localStorage | Full-bleed canvas **behind** editor; code floats over it; one key toggles code visibility |
| Generant WS client (`ws://127.0.0.1:57143`) | Desktop remote with OSC-style addresses | Phase 4–5 reuse / extend the bridge pattern for inbound control and render pipeline |

leyzah does **not** own transport. Inside zippah it shares the metro and pattern players. Outside tools send messages with musical time; leyzah schedules against that time, not arrival time.

## Product decisions (locked)

1. **One app.** zippah stays the only editor. leyzah is a module under the hood.
2. **Full-bleed.** Artwork fills the viewport background; code floats on top and stays visible by default (including live performance). One key command hides/shows the code layer. Code legibility over busy visuals (backdrop, outline, auto-contrast, …) is an open question — see below.
3. **Graph model.** Sources → effects → outputs, composed with Clojure threading (`->`).
4. **`scene`.** Takes a vector of object maps; a single map is shorthand for a one-element vector.
5. **Signals.** Every numeric parameter may be a signal on the shared musical clock (`lfo`, `beat`, `seq`, `env`). Palettes are first-class and indexable by signals.
6. **Procedural scenes.** Ordinary Clojure seq tools (`for` / `range`, lazy seqs). `defscene` declares named macros/params; changing a structural param (e.g. density) rebuilds deliberately.
7. **External control.** `bind` maps incoming messages onto macros (range / smooth / decay). `on` / `cue` trigger scene changes (e.g. when a pattern starts, quantized to the next bar). Senders emit raw values; mapping lives in leyzah so any tool can drive it.
8. **Transport.** In-process: share zippah clock + `:emit` on `pbind`. Out-of-process: WebSocket bridge with OSC-style addresses (browsers cannot receive raw OSC/UDP). Messages carry beat / timestamp. Audio reactivity may also come from analysing audio locally.

## Influences — and what we do differently

**Hydra** ([hydra.ojack.xyz](https://hydra.ojack.xyz)) is the closest visual ancestor: live-coded sources and effects, feedback-friendly, performance-oriented. We take the *idea* of a composable visual chain, not its JS API, GLSL library, or source.

**Overtone / SuperCollider** shape zippah’s *sound* language. leyzah reuses that musical clock and pattern vocabulary rather than inventing a parallel “visual BPM.” We do not port SC’s OpenGL or GUI stack.

**Strudel** shapes the page (one buffer, eval in place). Visuals belong under that buffer, not in a separate Hydra-style iframe or second window.

Deliberate differences from Hydra:

| Hydra-like default | leyzah |
| --- | --- |
| Standalone JS sketch / editor | Library inside zippah’s Clojure REPL |
| Visual time often local / RAF | Shared metro + pattern quant; external messages carry musical time |
| Method chaining in JS | Clojure `->` threading; maps and seqs for scenes |
| Primarily 2D shader sources | Shader sources **plus** first-class Three.js scenes that render to a texture into the same 2D effect chain |
| Control often ad hoc | Explicit `bind` / `on` / `cue` with mapping on the visual side; `:emit` from patterns |

## Language surface (target)

Syntax below is **target**. Nothing here runs until later phases.

### Graph: sources → effects → out

```clojure
(-> (noise 0.4)
    (warp (lfo 0.1) 0.3)
    (feedback 0.85)
    (out))
```

**Sources (planned families):**

- Shader generators — noise, gradients, voronoi, …
- Video / camera / clips
- Text / SVG
- Three.js scenes (via `scene`) — render to a texture, then enter the 2D effect chain

**Effects (planned families):**

- Color — hue, posterize, palette, threshold
- Space — warp, kaleido, tile, displace
- Time — feedback, trails, delay
- Combine — blend, mask, key

**Outputs:** `out` (fullscreen canvas). Later: secondary outputs / capture hooks for Generant’s MP4 pipeline (Phase 5).

### Scenes (Three.js → texture → effects)

```clojure
(scene [{:mesh :torus :spin (lfo 0.5)}
        {:mesh :cube  :scale 2 :pos [2 0 0]}])

;; single map = vector of one
(scene {:mesh :cube :scale (beat 4 0.5 2)})
```

### Signals and palettes

Every numeric param can be a constant or a signal:

| Signal | Intent |
| --- | --- |
| `(lfo rate)` | Low-frequency oscillator on the metro |
| `(beat n lo hi)` | Step / pulse tied to beat subdivisions |
| `(seq xs)` | Cycle values on a beat grid (same spirit as `pseq`) |
| `(env …)` | Event-triggered envelope (from `:emit`, `on`, or binds) |

Palettes are first-class:

```clojure
(def night (palette [[0.02 0.05 0.12] [0.1 0.4 0.9] [0.9 0.85 0.7]]))
(-> (noise 0.3)
    (palette night (beat 8 0 1))
    (out))
```

### Procedural construction and `defscene`

```clojure
(defscene field [density 60 spread 12 size 1]
  (for [_ (range density)]
    {:mesh :cube
     :pos (rand-pos spread)
     :scale size}))

;; use
(-> (scene (field))
    (warp 0.2 0.1)
    (out))

;; live: tweak a continuous macro
(field :size 1.4)

;; structural change (density) rebuilds the object list deliberately
(field :density 120)
```

`defscene` macros are the unit `bind` and cues target — analogous to how `pdef` ids are the unit of live pattern swap.

### External control

```clojure
;; Incoming raw value → macro, with mapping owned by leyzah
(bind field :size "/generant/macro/1" {:range [0.2 3] :smooth 0.15})

;; When pattern :bass (re)starts, cue a scene swap on the next bar
(on :bass-start
    (cue {:quant 4}
      (-> (scene (field :density 40 :size 0.8))
          (feedback 0.7)
          (out))))
```

Senders (Generant, agents, MIDI→WS bridges) send raw floats / triggers. Range, smoothing, and decay stay in leyzah so any tool can drive the same macros without knowing visual internals.

### Pattern bridge: `:emit`

Patterns already schedule events via `pbind` → `play-event` on the metro. Add an optional key that announces to leyzah without changing sound semantics:

```clojure
(pdef :kick
  (pbind :instrument :sc808_bassdrum
         :dur 1
         :amp 1.5
         :emit :kick)          ; visual bus name / event id
  {:metro m :quant 4})
```

Rests still rest. `:emit` fires on sounding events (and optionally on pattern start — exact start semantics are an open question). Handlers / `env` / scene macros subscribe by name.

## UI: full-bleed behind the editor

Target layout:

1. Full-viewport WebGL canvas (leyzah output) as the bottom layer.
2. Existing header / editor / transcript float above with transparent (or lightly treated) backgrounds.
3. Code visible by default; one key (TBD — candidate: `Mod-\\` or a dedicated chrome button) toggles the code layer hidden for projection / recording.
4. Eval / stop / Boot behaviour unchanged.

Open: how to keep code legible over busy shaders (semi-opaque backdrop behind lines, text stroke/outline, auto-contrast sampling, dimming the visual under the editor, or a combination). Default should favour readability for rehearsal; performance hide remains one keystroke.

## Transport and bridges

### Inside zippah

- Visual RAF / GPU clock **samples** signal values at the current musical time from the active metro (`(m)`, `(m beat)`, engine `(now)`).
- Pattern `:emit` and `on`/`cue` use the same `quant-beat` / `apply-by` lookahead pattern as `pdef` and `beat-loop` — so visuals and audio agree on bar lines.
- Hot-swap of the visual graph must not black-frame: prepare the next pipeline, then atomically flip (double-buffer / ping-pong FBOs — Phase 1 acceptance criterion).

### Outside tools

Browsers cannot bind UDP OSC. Path:

```
External tool  --OSC or native-->  local bridge  --WebSocket-->  zippah/leyzah
```

Generant already exposes a WebSocket remote on `127.0.0.1:57143` with OSC-style addresses (`/generant/v1/...`). leyzah listens for a small address family (names TBD), e.g.:

- `/leyzah/macro/:id` — raw float
- `/leyzah/cue/:name` — trigger
- `/leyzah/time` — beat + timestamp (or piggyback time on every message)

Every control message should carry **musical time** (beat and/or engine-compatible timestamp) so scheduling is not “when the packet arrived.”

Local audio analysis (AnalyserNode on SuperSonic’s output, or a tap) is a second reactivity path that does not require a bridge.

## Worked example (target syntax)

Sound + visuals in one buffer. Kick scales a cube field; bass notes stretch it; when the bass pattern restarts, cue a denser scene on the next bar.

```clojure
;; --- target syntax (not implemented in Phase 0) ---

(defsynth pluck-bass [note 40 amp 0.35 cutoff 1400]
  (* amp (env-gen (perc 0.005 0.35) :action FREE)
     (rlpf (saw (midicps note)) cutoff 0.25)))

(def m (metro 118))

(defscene field [density 48 spread 10 size 1 stretch 1]
  (for [_ (range density)]
    {:mesh :cube
     :pos (rand-pos spread)
     :scale [(* size stretch) size size]}))

(-> (scene (field))
    (warp (lfo 0.08) 0.15)
    (feedback 0.82)
    (out))

;; kick hits punch :size via :emit → env
(pdef :kick
  (pbind :instrument :sc808_bassdrum
         :dur 1
         :amp 1.4
         :emit :kick)
  {:metro m :quant 4})

(on :kick (field :size (env 1.8 0.05 0.35)))

;; bass notes stretch the field; emit carries the note for mapping
(pdef :bass
  (pbind :instrument pluck-bass
         :note (pseq [40 nil 40 43 nil 47 45 nil] :inf)
         :dur 0.5
         :amp 0.35
         :emit :bass-note)
  {:metro m :quant 4})

(on :bass-note
    (field :stretch (lin-lin :note 40 47 0.7 1.6)))

;; when :bass (re)starts / is re-evaluated, denser field on next bar
(on :bass-start
    (cue {:quant 4}
      (field :density 96 :size 0.85)))
```

## Phased plan

| Phase | Deliverable |
| --- | --- |
| **0** | This design doc (no runtime code). |
| **1** | leyzah module in zippah: full-bleed canvas behind editor; one shader source; two effects (`warp`, `feedback`); `out`; hot-swap without black frames; code toggle key. |
| **2** | Signals (`lfo`, `beat`, `seq`, `env`) + first-class palettes on the shared metro. |
| **3** | Three.js `scene`, `defscene`, procedural construction with ordinary seq tools; structural rebuild rules. |
| **4** | `bind` / `on` / `cue`; WebSocket bridge (OSC-style addresses + musical time); `pbind` `:emit`. |
| **5** | Generant link: event broadcast into leyzah; leyzah renderer as a **style** in Generant’s MP4 render pipeline ([Generant PR #2 — Render & Share](https://github.com/mxjxn/Generant/pull/2): bounce + social visualizers). |

Phase boundaries are feature gates, not calendar estimates. Each phase should leave the REPL usable with sound alone if visuals fail to init.

## Suggested module layout (open — see questions)

Sketch only; final paths decided in Phase 1:

```
src/leyzah/          # JS/WebGL runtime (canvas, graph, hot-swap)
src/clj/leyzah.cljs  # SCI surface (or forms folded into prelude like pattern.cljs)
docs/leyzah/         # this design + short notes
```

Keep GPU/runtime in JS; keep the live-coding vocabulary in Clojure evaluated through the existing Scittle prelude path (`src/prelude.js` → `src/clj/*.cljs`).

## Non-goals (for now)

- A second editor, Hydra-compatible sketch paste, or iframe host.
- Copying Hydra / Overtone / SC visual or server source.
- Replacing Generant’s existing pulse/ribbons/lattice/bars visualizers — Phase 5 **adds** a leyzah style beside them.
- Guaranteeing WebGPU on day one (see open questions).
- Perfect offline / background-tab visual timing before zippah’s Worker clock exists (same limitation as audio loops today).

## Open questions

1. **WebGL2 vs WebGPU.** WebGL2 has broader reach and simpler Three.js interop today; WebGPU is the longer-term compute path. Phase 1 recommendation: WebGL2 with an abstraction thin enough to revisit.
2. **Module layout inside zippah.** Separate `src/leyzah/` + `leyzah` ns vs. folding early forms into `user` like patterns. Preference: dedicated ns early so `(require …)` / docs stay clear, while Phase 1 may still auto-load into the prelude.
3. **Code-legibility treatment.** Backdrop vs outline vs auto-contrast vs dim-under-editor — pick a default before Phase 1 UI lands; keep toggles few.
4. **Message schema details.** Exact WS JSON shape (address, args, beat, timestamp, origin); whether time is always required; how `/leyzah/*` coexists with `/generant/v1/*` on the same socket.
5. **Performance budget.** Cap scene object counts; shader complexity; feedback resolution; what happens when `defscene` density explodes mid-set. Need a stated floor (e.g. target 60 fps at 1080p on a mid laptop with ≤N meshes + one feedback chain) before Phase 3.
6. **`:emit` / pattern-start semantics.** Does re-eval of `pdef` fire `:bass-start`? Only the first `start-player`? Optional opts map?
7. **License packaging.** zippah is AGPL-3.0-or-later (SuperSonic). leyzah source in-tree inherits that. Three.js and any shader deps need license review before Phase 3. Generant (MIT) consuming a leyzah style in its render pipeline must stay a clean boundary (run/render contract, not copy AGPL into Generant’s MIT tree carelessly).

## Related docs

- [README.md](../../README.md) — how zippah runs today
- [GENERANT_INTEGRATION.md](../GENERANT_INTEGRATION.md) — banks / live link context (WebSocket remote, clocks)
- [NEXT_STEPS.md](../../NEXT_STEPS.md) — known audio/REPL gaps (Worker clock, etc.)
- Generant [PR #2](https://github.com/mxjxn/Generant/pull/2) — Render & Share / MP4 visualizers (Phase 5 hook)

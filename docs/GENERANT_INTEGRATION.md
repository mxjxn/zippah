# Generant ↔ zippah integration

Planning doc only. No code changes implied by this file. Observed
2026-11-14 against `mxjxn/zippah` `main` and `mxjxn/Generant` `main`
(banks commit `1fcacb9`, Clip Player `cf32b31`).

## Summary and recommendation

**Recommend a Clojure bank/lane surface in zippah that speaks Generant's
bank JSON, backed by a tiny shared pure-ESM module extracted from
`shared/banks.mjs` (approach 3 + a narrow slice of approach 1).**

Keep engines, schedulers, and synthdef pipelines separate. Do not import
the full Generant project model or `.rack.json` yet. Live OSC link and a
native-only Clojure reimplementation remain useful later options, not the
first cut.

That gives live-coding the ReBirth-style bank vocabulary without marrying
the two clocks, UIs, or licenses into one product.

## Current state (observed)

### zippah

Browser live-coding REPL: Clojure (SCI/Scittle) over SuperSonic WASM
scsynth 0.97.0. No Java; zero install beyond `npm`. License is
**AGPL-3.0-or-later** (SuperSonic); Scittle is EPL-1.0 — still an open
compatibility question before wider distribution.

Already on `main`: `defsynth` / `demo` with in-browser SynthDef byte
compiler (`src/synthdef.js`), ugens, `metro` / `at` / `apply-by` on the
engine NTP clock, `beat-loop` / `seq-loop`, SuperCollider-shaped patterns
(`pbind`, `pdef`, value patterns, bar `:quant`), Sonic Pi synthdefs and
samples, `(note)` / `(scale)` / `(chord)`. Timing: JS timers only wake
lookahead; sound is always timestamped OSC bundles.

Not built: song arrangement, tracker/piano roll, degree/scale event
defaults, `ppar` / `pmono`, Worker clock, Strudel-like player UI. Listen
pass (`LISTEN_REPORT.md`) confirmed audio paths work.

### Generant

Electron/JS desktop workstation on SuperSonic **0.88.0** (older than
zippah). MIT. Tracker + piano roll, song mode (pattern pool + ordered
positions), modular rack with CV, presets, MIDI, OSC/Blender export,
`.rack.json` projects. Also has `npm run dev:web` (browser UI shell) and
UDP remote control on `127.0.0.1:57142` (`/generant/v1/...`).

SynthDefs live in `sc/`, compiled with sclang to `public/synthdefs/*.scsyndef`.
Pure logic sits in `shared/` (~450 lines across ESM modules). Clock model:
pattern `rows` + `lpb` (rows-per-beat); song positions resolve to beat
segments via `compileSong`.

**Tonight's landings (2026-11-13):**

- `1fcacb9` Pattern banks — `shared/banks.mjs`: bank defs
  `{instrument keys|clip, key, scale, bpm, patterns[]}` with sparse step
  grids (`note` / `velocity` / `gate` 0–4 steps); lanes bound to devices
  with scale-locked degree or semitone transpose, hard/env gate,
  gate/velocity scale, decay/release multipliers. `applyBankLanes` runs
  inside `compileSong` (same note stream, no second sequencer).
  `bakeLaneToPattern`; tests in `tests/banks.test.mjs`.
- `cf32b31` Clip Player — chromatic one-shot sampler device (`clip`):
  trim, root transpose, gate/ADSR, filter, drive, pitch sweep; reuses
  `rackKitSample` voice.

Banks are new and small. Full Matrix A–D banks in `TODO.md` are still a
separate future milestone.

## Concept mapping

| Generant | Meaning today | Closest zippah equivalent |
| --- | --- | --- |
| **Bank** | Named def: instrument + key/scale/bpm + named step patterns | No direct peer. Closest: a named `pdef` recipe plus `(scale)` / root; would be a new `(defbank …)` / bank atom |
| **Lane** | Performance binding: bank pattern → device, with transpose/gate/vel/decay transforms | No peer. Closest: live args on a `pdef` / `ctl`; would be `(lane …)` options feeding one player |
| **Pattern** (bank) | Sparse rows×lpb step grid (typically 16ths) | `pbind` + `pseq` / rests (`nil` → `:rest`); durations in beats, not step gates |
| **Pattern** (song) | Full musical snapshot (notes, drums, FX, OSC) in the song pool | No song pool. One live `pdef` or loop is the unit of play |
| **Clip** | Clip Player device + embedded sample + chromatic notes | `(sample …)` / `sample-player` on Sonic Pi buffers, or a `defsynth` around `play-buf`; no chromatic root/trim device yet |
| **Scale** | Bank `SCALES` pitch-class sets + `degreeToSemis` | `(scale :c3 :minor)` returns MIDI degrees for one octave; no degree→semitone helper for bank transpose |
| **Gate** | Step length in grid steps (hard cut) or env/legato to next step | Event `:dur` in beats; synth envelopes are separate (`perc` / ADSR inside `defsynth`) |
| **Song position** | Ordered entry in `song.order`; segment `start`/`beats` in `compileSong` | Metro beat number + `:quant` bar boundary; no arrangement timeline |

**Clock gap in one line:** Generant schedules absolute song beats from
compiled segments (`rows/lpb`); zippah schedules relative metro beats with
optional bar quantize and live pattern swap. Any shared bank must render
to **beat-relative note events**, then each host maps those onto its own
clock.

## Approaches compared

| Approach | Effort | Coupling | Clock fit | Synthdefs | Samples/clips | License | Testing | Live-coding gain / loss |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **1. Shared JS core package** | Medium–high if whole `shared/`; **low–medium if only `banks.mjs` + scales** | High for full model; **low for bank-only** | Shared render → beats; each app keeps scheduler | Sharing `sc/` defs needs binary `.scsyndef` + SuperSonic version align (0.88 vs 0.97) | Clip embeds are base64 project data; browser needs fetch/File/Blob path | Generant MIT extract is fine; zippah AGPL consumer must comply; don't pull AGPL into Generant | Generant already has `banks.test.mjs`; reuse as package tests | Gain: one source of truth for bank math. Loss: packaging/versioning tax; full extract pulls workstation assumptions into the REPL |
| **2. Interchange format only** | High for full `.rack.json`; **low for bank JSON subset** | Low runtime; high schema vigilance | Must translate song beats ↔ metro; song positions have no zippah peer | Each app keeps its own sounds; bank JSON does not carry synth graphs | Clip `data:` URLs may be huge; browser memory/CSP limits | MIT data into AGPL app is OK; exporting AGPL-touched assets back needs care | Round-trip fixtures on bank defs + golden `renderLane` output | Gain: files move between tools. Loss: no shared live feel; full rack import is a second product |
| **3. Clojure surface over Generant concepts** | Medium | Medium at the vocabulary layer only | Bank → events → `pdef`/`at` on metro; `:quant` for launches | Keep zippah `defsynth` / Sonic Pi names; map lane `decayMul`/`releaseMul` onto synth params when present | `(sample)` first; Clip Player parity later | Forms are new zippah code (AGPL); bank JSON schema can stay MIT-compatible | Port `banks.test.mjs` cases into Clojure/JS hybrid tests | **Gain: best live-coding fit** — re-eval bank/lane like `pdef`. Loss: workstation UI features stay in Generant |
| **4. Live link (OSC / WebSocket)** | Medium (Generant remote exists); browser needs a bridge (no raw UDP) | Low code sharing; high operational coupling | Two clocks; quantize commands to bar/position boundaries | No sharing required | N/A for control-only | Protocol can be MIT-documented; apps stay separate licenses | Contract tests on `/generant/v1` + a small WS↔UDP bridge | Gain: zippah as controller / Generant as sound stage (or reverse). Loss: requires desktop Generant running; offline browser story weak |
| **5. Native reimplement in `pbind`/`pdef`** | Low–medium | Lowest | Natural on metro; conceptual compatibility only | Native | Native | No Generant code copied — cleanest legally if in doubt | New zippah tests; optional golden vectors vs Generant | Gain: ships fastest inside zippah. Loss: drift risk; dual maintenance if Max uses both daily |

### Reflection (why not the others as the first move)

Full shared-core monorepo (wide approach 1) over-couples: `model.mjs` /
`song.mjs` / `studio.mjs` assume devices, clips, song order, and Electron
validation. Banks are the only piece that is already a pure note-stream
transform.

Full `.rack.json` interchange (wide approach 2) is a workstation
importer, not a live-coding feature. The bank def subset is worth keeping
as the interchange *shape*, not the whole project.

Live link (4) is attractive because Generant already speaks
`/generant/v1/transport/*` and song/pattern queue — but browsers cannot
UDP, so a local bridge is mandatory, and you still need bank authoring
somewhere. Treat it as phase 2+.

Native-only port (5) is the right *fallback* if packaging a shared module
is more friction than it is worth; keep the JSON field names identical so
approach 2's bank subset still works later.

## Recommended shape

1. **Shared package (narrow):** extract MIT-licensed pure functions —
   `SCALES`, `degreeToSemis`, `validateBankDef`, `renderLane`, lane
   defaults — from Generant `shared/banks.mjs`. No `compileSong`, no
   Electron, no Java. Host: small npm package, or git subtree under both
   repos. Generant keeps `applyBankLanes` / `bakeLaneToPattern` as thin
   wrappers over the shared render.
2. **zippah Clojure API:** forms in the spirit of
   `(defbank …)`, `(lane …)`, `(play-bank …)` / `pdef` integration that
   call the shared render (or a SCI-friendly JS interop), emit events
   `{beat, pitch, duration, velocity}`, then play them with existing
   `at` + `play-event` on a metro with `:quant`.
3. **Interchange:** read/write **bank JSON** (defs + optional lanes), not
   full `.rack.json`, in the first milestones.
4. **Explicit non-goals for v0:** sharing `sc/` SynthDefs, running the
   Generant rack UI in the browser, or syncing song positions.

## Phased plan

### Milestone 0 — freeze the contract

- Document the bank def + lane JSON (fields already enforced by
  `validateBankDef` / `validateLane`).
- Export golden vectors from Generant `tests/banks.test.mjs`
  (hard gate, env gate, scaleLock transpose, tiling).
- Decide package home (see open questions).

### Milestone 1 — shared bank math (small first slice)

- Extract the pure helpers into a shared ESM module; Generant imports it;
  keep `applyBankLanes` in Generant.
- Same golden tests run in the package. No zippah UI yet.

### Milestone 2 — zippah play-bank slice

- Load a bank def (inline map or JSON).
- `(play-bank …)` or `pdef` wrapper: render N beats (or `:inf` tiling),
  schedule via metro + `:quant 4`.
- Lane transpose / gateMode / velocityScale as live-redefinable opts
  (swap like `pdef`).
- Headless tests: render matches golden vectors; player advances on beat
  grid.

### Milestone 3 — bank file I/O

- Import/export bank JSON between the two apps.
- Optional: strip `banks` from a `.rack.json` without loading the rest.

### Milestone 4 — sound parity enough to jam

- Map lane `decayMul` / `releaseMul` onto zippah synth params when the
  instrument declares them.
- Clip story: load a user sample into a buffer; chromatic play relative
  to a root (Clip Player subset). Prefer fetch/File APIs; no Java; watch
  memory for embedded base64.

### Milestone 5 (optional) — live link

- WebSocket (or local helper) ↔ Generant UDP `57142`.
- zippah sends transport / tempo / queue pattern; Generant remains the
  audio host for rack devices.
- Only after Milestones 1–2 feel good in the browser alone.

## Risks and open questions

**License.** Generant MIT vs zippah AGPL-3.0-or-later, plus Scittle EPL-1.0.
A shared MIT bank package is fine for both. Shipping AGPL zippah that
embeds Generant UI/engine code is a different question. Resolve EPL vs
AGPL before any combined distribution or npm publish of zippah itself.

**Where shared code lives.** Options: (a) new public MIT repo
e.g. `mxjxn/generant-banks`, (b) npm package published from Generant
`shared/banks`, (c) git subtree/submodule. Prefer (a) or (b) so Generant
does not grow an AGPL dependency.

**SuperSonic versions.** zippah 0.97.0 vs Generant 0.88.0. Do not assume
binary synthdefs or engine quirks match until both pin the same major
line.

**Synthdef sharing.** Generant's `sc/` → `.scsyndef` path needs sclang;
zippah's promise is in-browser `defsynth`. Sharing sounds means either
shipping precompiled defs (AGPL engine package already does this for
Sonic Pi) or rewriting Clip/FM-style voices as `defsynth` forms. Do not
copy Overtone/SuperCollider sources.

**Sample/clip loading.** Generant embeds base64 in the project (caps
~40 MB / 120 s for clips). Browsers need explicit user gesture, CORS, and
memory budgets. Start with URL or File-picker buffers, not full project
embeds.

**Should Generant run in the browser?** `dev:web` already serves UI;
audio is still the hard part (COOP/COEP vs `postMessage` mode, sample
sync, desktop OSC). A browser Generant is a product decision, not
required for zippah bank live-coding. If pursued, it competes with zippah
unless roles stay clear: Generant = arrange/rack, zippah = REPL.

**Clock semantics.** Env-gate wrap-around and `lpb` 2 vs 4 must match
golden tests exactly or files will disagree. Song positions have no
zippah peer — do not fake them in v0.

**No-Java hard constraint.** Shared code must be ESM/ClojureScript only.
No sclang in the zippah boot path.

**Testing.** Keep Generant's six bank tests as the contract. Add zippah
player tests for quant and live lane swap. Avoid screenshot/Electron
tests for the shared math.

## Top open questions for Max

1. License direction for zippah (AGPL keep vs dual/other) given Scittle EPL
   and a desire to share MIT bank code with Generant.
2. Home for the shared bank module (new MIT repo vs publish from Generant).
3. Is the first joy “type banks in the browser REPL”, “bounce bank JSON
   into the desktop rack”, or “zippah remote-controls Generant”?
4. SuperSonic version alignment — upgrade Generant toward 0.97, or accept
   permanent engine fork?
5. How much Clip Player / Four FM parity does browser live-coding need
   before banks feel real?

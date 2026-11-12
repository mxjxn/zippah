;; Prelude part 1 of 4 (core -> ugens -> synth -> time), evaluated into SCI
;; (via Scittle) once at page load. An Overtone-flavoured surface over the
;; JS bridge `js/ovt` (see src/engine.js).
(ns user)

(defn synth-name
  "Keywords/symbols are short Sonic Pi names (:prophet -> \"sonic-pi-prophet\").
   Strings are used as-is."
  [s]
  (if (string? s)
    s
    (let [n (name s)]
      (if (.startsWith n "sonic-pi-") n (str "sonic-pi-" n)))))

(defn- flat-params
  "Accepts either a single map {:note 60} or keyword args :note 60.
   Returns a flat [\"note\" 60 ...] vector for OSC."
  [args]
  (let [pairs (cond
                (empty? args) []
                (and (= 1 (count args)) (map? (first args))) (seq (first args))
                (even? (count args)) (partition 2 args) ; keeps written order
                :else (throw (ex-info "params must be a map or key/value pairs"
                                      {:args (vec args)})))]
    (vec (mapcat (fn [[k v]]
                   [(name k) (if (keyword? v) (name v) v)])
                 pairs))))

(defn send
  "Raw OSC to scsynth: (send \"/n_set\" 1001 \"cutoff\" 90)"
  [address & args]
  (.send js/ovt address (clj->js (vec args)))
  :sent)

(defn boot
  "Audio can only start from a user gesture, so press the Boot button.
   Returns the engine status."
  []
  (keyword (.status js/ovt)))

(defn status [] (keyword (.status js/ovt)))

(defn load-synthdef
  "Load a shipped Sonic Pi synthdef by name: (load-synthdef \"sonic-pi-prophet\")
   or (load-synthdef :prophet). Returns a promise."
  [s]
  (.loadSynthDef js/ovt (synth-name s)))

(defn synthdefs
  "Names of synthdefs currently loaded in the engine."
  []
  (vec (.loadedSynthDefs js/ovt)))

(defn s-new
  "Create a synth node and return its node id.
   (s-new \"sonic-pi-prophet\" :note 60 :release 8 :cutoff 70)
   Loads the synthdef first if it is not loaded yet."
  [synth & params]
  (.sNew js/ovt (synth-name synth) (clj->js (flat-params params))))


(defn- synth-fn? [x] (and (fn? x) (some? (:ovt/synth (meta x)))))

(defn play
  "Friendlier alias: (play :prophet {:note 60 :release 4}); also accepts a defsynth."
  [synth & params]
  (if (synth-fn? synth)
    (apply synth params)
    (apply s-new synth params)))

(def inst-groups (atom {})) ; definst name -> group id

(defn- node-target
  "node id, or a definst (its group)"
  [x]
  (cond
    (number? x) x
    (synth-fn? x) (let [sd (:ovt/synth (meta x))]
                    (or (and (:inst sd) (get @inst-groups (:name sd)))
                        (if (:inst sd)
                          (throw (ex-info (str (:name sd) " has no running notes yet") {}))
                          (throw (ex-info (str (:name sd) " is a defsynth, not a node: ctl/kill take the node id it returned (or use definst)") {})))))
    :else (throw (ex-info (str "expected a node id, got " (pr-str x)) {}))))

(defn ctl
  "Change params on a running node (or every note of a definst): (ctl id :cutoff 100)"
  [node & params]
  (if (sequential? node)
    (doseq [n node] (apply ctl n params))
    (apply send "/n_set" (node-target node) (flat-params params)))
  :ok)

(defn kill
  "Free a node (or all notes of a definst): (kill id)"
  [node]
  (cond
    (sequential? node) (doseq [n node] (kill n))
    (synth-fn? node) (send "/g_freeAll" (node-target node))
    :else (send "/n_free" (node-target node)))
  :ok)

(defn tree
  "The engine's current node tree (groups and running synths)."
  []
  (js->clj (.tree js/ovt) :keywordize-keys true))

(def ^:private note-offsets {"c" 0 "d" 2 "e" 4 "f" 5 "g" 7 "a" 9 "b" 11})

(defn note
  "MIDI note number from a keyword like :c4, :fs3 (sharp), :eb2 (flat). :c4 = 60.
   Numbers pass through; vectors map."
  [n]
  (cond
    (number? n) n
    (sequential? n) (mapv note n)
    :else
    (let [s (name n)
          [_ letter acc octave] (re-matches #"(?i)([a-g])(s|#|b)?(-?\d+)" s)]
      (when-not letter
        (throw (ex-info (str "not a note: " s) {:note n})))
      (+ (get note-offsets (.toLowerCase letter))
         (case acc ("s" "#") 1 "b" -1 0)
         (* 12 (inc (js/parseInt octave)))))))

(def ^:private scale-steps
  {:major [2 2 1 2 2 2 1] :minor [2 1 2 2 1 2 2] :dorian [2 1 2 2 2 1 2]
   :phrygian [1 2 2 2 1 2 2] :lydian [2 2 2 1 2 2 1] :mixolydian [2 2 1 2 2 1 2]
   :minor-pentatonic [3 2 2 3 2] :major-pentatonic [2 2 3 2 3] :blues [3 2 1 1 3 2]
   :chromatic [1 1 1 1 1 1 1 1 1 1 1 1]})

(defn scale
  "(scale :c3 :minor) => MIDI notes for one octave (plus the octave)."
  [root kind]
  (let [steps (or (scale-steps kind) (throw (ex-info (str "unknown scale " kind "; try " (keys scale-steps)) {})))]
    (vec (reductions + (note root) steps))))

(def ^:private chord-shapes
  {:major [0 4 7] :minor [0 3 7] :dim [0 3 6] :aug [0 4 8] :sus2 [0 2 7] :sus4 [0 5 7]
   :7 [0 4 7 10] :maj7 [0 4 7 11] :m7 [0 3 7 10] :dom7 [0 4 7 10]})

(defn chord
  "(chord :e3 :minor) => [52 55 59]"
  [root kind]
  (let [r (note root)
        shape (or (chord-shapes kind) (throw (ex-info (str "unknown chord " kind "; try " (keys chord-shapes)) {})))]
    (mapv #(+ r %) shape)))

;; helpers the page uses to print results; not part of the language surface
(defn __pr [x] (pr-str x))
(defn __err-data [e]
  (let [d (ex-data e)]
    (when (or (= :edamame/error (:type d)) (= "analysis" (:phase d)))
      (str "(line " (:line d) ", col " (:column d) ")"))))

;; ---------------------------------------------------------------------
;; Time. Every timed sound is an OSC bundle with an NTP timetag that the
;; engine schedules sample-accurately. JS timers only wake loops up
;; ahead of time (lookahead) so they can send their next bundles.
;; Times are milliseconds on the engine clock: (now), (+ (now) 500), (m 16).
;; ---------------------------------------------------------------------
(ns user)

(defn now
  "Current engine time in ms (NTP-based)."
  []
  (.now js/ovt))

(defmacro at
  "Everything sent inside the body goes out as one timestamped bundle:
   (at (+ (now) 500) (bass 40) (ctl id :cutoff 300))"
  [t & body]
  `(let [t# ~t]
     (.beginAt js/ovt t#)
     (let [r# (try (do ~@body)
                   (catch :default e# (.abortAt js/ovt) (throw e#)))]
       (.endAt js/ovt)
       r#)))

(defmacro after
  "(after 250 (kick)) - like at, relative to now in ms."
  [ms & body]
  `(at (+ (now) ~ms) ~@body))

(defn apply-at
  "Call (f args...) at engine time t (ms). Use (at t ...) inside f for sound."
  [t f & args]
  (.callAt js/ovt t #(apply f args))
  :scheduled)

(defn apply-by
  "Call (f args...) a little before t (the lookahead), so f can schedule
   sound exactly at t. Overtone's temporal-recursion idiom."
  [t f & args]
  (.callAt js/ovt (- t (.lookahead js/ovt)) #(apply f args))
  :scheduled)

(defn metro
  "(def m (metro 120))  (m) => next beat number  (m 8) => time of beat 8 (ms)
   (m :bpm) => tempo  (m :bpm 140) => change tempo, keeping the current beat.
   The clock starts on first use (after Boot)."
  [bpm]
  (let [state (atom {:bpm bpm :start nil})
        start! (fn []
                 (or (:start @state)
                     (:start (swap! state assoc :start (+ (now) (.lookahead js/ovt))))))
        beat-ms (fn [] (/ 60000 (:bpm @state)))]
    (fn
      ([] (let [s (start!)] (inc (js/Math.floor (/ (- (now) s) (beat-ms))))))
      ([b] (if (= b :bpm)
             (:bpm @state)
             (+ (start!) (* b (beat-ms)))))
      ([k v]
       (case k
         :bpm (let [s (start!) t (now)
                    pos (/ (- t s) (beat-ms))]
                (swap! state assoc :bpm v :start (- t (* pos (/ 60000 v))))
                v)
         (throw (ex-info (str "metro: unknown option " k) {})))))))

(defn metro-bpm
  ([m] (m :bpm))
  ([m bpm] (m :bpm bpm)))

(defn beat-ms
  "Duration of n beats in ms for a metro."
  [m n]
  (* n (/ 60000 (m :bpm))))

;; --- named, live-redefinable loops ---------------------------------------
(def loops (atom {})) ; id -> {:f :m :step :token}

(defn quant-beat
  "First beat at or after metro m's next beat that lands on a multiple of
   quant (plus phase). No quant => the next beat."
  ([m quant phase] (quant-beat m quant phase (m)))
  ([m quant phase from-beat]
  (let [nb from-beat
        phase (or phase 0)]
    (if (and (number? quant) (pos? quant))
      (+ phase (* quant (js/Math.ceil (/ (- nb phase) quant))))
      (+ nb phase)))))

(defn- check-quant-opts [who opts]
  (when (and (some? opts) (not (map? opts)))
    (throw (ex-info (str who ": options must be a map like {:quant 4 :phase 0}") {})))
  (let [{:keys [quant phase]} opts]
    (when (and (some? quant) (not (and (number? quant) (pos? quant))))
      (throw (ex-info (str who ": :quant must be a positive number of beats") {})))
    (when (and (some? phase) (not (number? phase)))
      (throw (ex-info (str who ": :phase must be a number of beats") {})))))

(defn beat-loop
  "Run (f beat) on every beat (or every step beats) of metro m, each call
   wrapped in (at (m beat) ...). Re-evaluating with the same id swaps in
   the new f/step without losing the beat. Optional trailing map:
   {:quant 4 :phase 0} starts the loop on the next multiple of 4 beats.
   (beat-loop :kick m (fn [b] (kick)))
   (beat-loop :kick m (fn [b] (kick)) {:quant 4})
   (beat-loop :hats m 0.5 (fn [b] (hat :amp (if (even? (* 2 b)) 0.6 0.3))) {:quant 4 :phase 0})"
  [id m & args]
  (let [[args opts] (if (map? (last args)) [(butlast args) (last args)] [args nil])
        [step f] (case (count args)
                   1 [1 (first args)]
                   2 args
                   (throw (ex-info "beat-loop: (beat-loop id m f), (beat-loop id m step f), optionally with a trailing {:quant n}" {})))]
    (check-quant-opts "beat-loop" opts)
    (when-not (and (number? step) (pos? step))
      (throw (ex-info "beat-loop: step must be a positive number of beats" {})))
    (when-not (fn? f)
      (throw (ex-info "beat-loop: f must be a function of the beat" {})))
    (if (contains? @loops id)
      (do (swap! loops update id assoc :f f :m m :step step)
          [:updated id])
      (let [token (js/Object.)]
        (swap! loops assoc id {:f f :m m :step step :token token})
        (letfn [(tick [beat]
                  (when-let [l (get @loops id)]
                    (when (identical? token (:token l))
                      (let [{:keys [f m step]} l]
                        (try
                          (at (m beat) (f beat))
                          (catch :default e
                            (swap! loops dissoc id)
                            (.log js/ovt "error" (str "loop " id " stopped at beat " beat ": " (ex-message e)))))
                        (when (contains? @loops id)
                          (let [nb (+ beat step)]
                            (apply-by (m nb) tick nb)))))))]
          (let [b0 (quant-beat m (:quant opts) (:phase opts))]
            (if (:quant opts)
              (apply-by (m b0) tick b0)   ; wake just ahead of the bar
              (tick b0))))
        [:started id]))))

(defn seq-loop
  "Step through a vector: nil is a rest. Optional trailing {:quant n :phase p}.
   (seq-loop :bass m 0.5 [40 nil 40 43 nil 47 45 nil] (fn [n] (bass n)))"
  ([id m step pattern f] (seq-loop id m step pattern f nil))
  ([id m step pattern f opts]
   (let [pattern (vec pattern)]
     (when (empty? pattern) (throw (ex-info "seq-loop: empty pattern" {})))
     (beat-loop id m step
                (fn [b]
                  (let [i (js/Math.round (/ b step))
                        v (nth pattern (mod i (count pattern)))]
                    (when (some? v) (f v))))
                (or opts {})))))

(defn stop-loop [id] (swap! loops dissoc id) [:stopped id])
(defn running-loops [] (vec (keys @loops)))

(defn stop
  "Silence everything: cancels loops and pending timers, drops scheduled
   bundles (purge + /clearSched), and deep-frees every synth."
  []
  (reset! loops {})
  (.stop js/ovt)
  :stopped)

(defn help []
  (str "sound:  (demo (sin-osc 440))  (demo 4 (* 0.2 (lpf (saw [110 111]) (line:kr 200 4000 4))))\n"
       "synths: (defsynth bass [note 40 amp 0.3] (* amp (env-gen (perc) :action FREE) (saw (midicps note))))\n"
       "        (bass 43) (bass :note 45) (def id (bass)) (ctl id :amp 0.1) (kill id)  definst, synth, defcgen\n"
       "time:   (now) (at t ...) (after ms ...) (def m (metro 120)) (m) (m 8) (m :bpm 140)\n"
       "        (beat-loop :id m f) (beat-loop :id m 0.5 f) (seq-loop :id m step [..] f) (stop-loop :id) apply-by\n"
       "samples:(sample :bd_haus) (load-sample :loop_amen) (sample-player buf :rate 0.5)\n"
       "first slice: (play :prophet {:note 60}) (s-new \"sonic-pi-beep\" :note 72) (load-synthdef :tb303)\n"
       "other:  (stop) (tree) (synthdefs) (ugens) (ugen-doc 'lpf) (group) (audio-bus) (note :c4) (scale :c3 :minor) (chord :e3 :m7)"))

;; ---------------------------------------------------------------------
;; Patterns, written fresh after SuperCollider's pattern *behaviour*.
;;
;; A pattern is a stateless recipe: {:ovt/type :pattern :kind .. :seq f}
;; where (f) returns a fresh lazy seq of its values. (as-stream p) makes a
;; stateful stream; (next s) pulls one value, (reset s) rewinds.
;;
;; Values: anything that is not a pattern is a constant infinite pattern of
;; itself. nil in a list (or a nil constant) is a REST and comes out of a
;; stream as :rest. A stream returning nil means it has ENDED (SC semantics).
;; Patterns inside lists are embedded (played through) like SC.
;;
;; Players (pdef / pplay) walk an event stream on a metro's beat grid and
;; send every event as an (at (m beat) ...) bundle; a JS timer only wakes
;; the player ~lookahead early, exactly like beat-loop.
;; ---------------------------------------------------------------------
(ns user)

(defn pattern? [x] (and (map? x) (= :pattern (:ovt/type x))))
(defn stream? [x] (and (map? x) (= :stream (:ovt/type x))))
(defn rest? [x] (= :rest x))

(defn- mkpat [kind f] {:ovt/type :pattern :kind kind :seq f})

(defn- ->seq
  "Lazy seq of a pattern's values. Constants repeat forever."
  [p]
  (cond
    (pattern? p) ((:seq p))
    (nil? p) (repeat :rest)
    :else (repeat p)))

(defn- embed
  "Items as they appear in a list pattern: patterns are played through,
   nil becomes a rest, anything else is one value."
  [item]
  (cond
    (pattern? item) ((:seq item))
    (nil? item) (list :rest)
    :else (list item)))

(defn- reps [r who]
  (cond
    (= r :inf) js/Infinity
    (and (number? r) (>= r 0)) r
    :else (throw (ex-info (str who ": repeats/length must be a number or :inf, got " (pr-str r)) {}))))

(defn- concat-lazy
  "Lazily concatenate (gen 0) (gen 1) ... for i < n; unchunked."
  [n gen]
  (letfn [(step [i] (lazy-seq (when (< i n) (concat (gen i) (step (inc i))))))]
    (step 0)))

(defn- generate
  "Unchunked lazy seq of (f) results; f is called once per element."
  [n f]
  (letfn [(step [i] (lazy-seq (when (< i n) (cons (f) (step (inc i))))))]
    (step 0)))

(defn- check-list [who xs]
  (when-not (sequential? xs)
    (throw (ex-info (str who ": first arg must be a vector/list of items") {})))
  (vec xs))

;; --- streams -------------------------------------------------------------
(defn as-stream
  "Make a stateful stream from a pattern (or constant). Streams pass through."
  [p]
  (if (stream? p)
    p
    {:ovt/type :stream :pattern p :state (atom (->seq p))}))

(defn next
  "(next stream) pulls the next value, nil when the stream has ended.
   On anything that is not a stream it is clojure.core/next."
  [s]
  (if (stream? s)
    (let [st (:state s)
          xs (seq @st)]
      (when xs
        (reset! st (clojure.core/rest xs))
        (first xs)))
    (clojure.core/next s)))

(defn reset
  "Rewind a stream to the start of its pattern (random patterns re-roll)."
  [s]
  (when-not (stream? s) (throw (ex-info "reset takes a stream from as-stream" {})))
  (reset! (:state s) (->seq (:pattern s)))
  s)

(defn next-n
  "Up to n values from a stream (fewer if it ends)."
  [s n]
  (loop [acc [] i 0]
    (if (< i n)
      (let [v (next s)]
        (if (nil? v) acc (recur (conj acc v) (inc i))))
      acc)))

;; --- list patterns --------------------------------------------------------
(defn pseq
  "(pseq [a b c] repeats offset) - the list in order, repeats times (default 1)."
  ([xs] (pseq xs 1 0))
  ([xs repeats] (pseq xs repeats 0))
  ([xs repeats offset]
   (let [v (check-list "pseq" xs) n (reps repeats "pseq") c (count v)]
     (mkpat :pseq (fn [] (if (zero? c) ()
                             (concat-lazy (* n c) (fn [i] (embed (nth v (mod (+ i offset) c)))))))))))

(defn prand
  "(prand [a b c] repeats) - a random item each time."
  ([xs] (prand xs 1))
  ([xs repeats]
   (let [v (check-list "prand" xs) n (reps repeats "prand")]
     (mkpat :prand (fn [] (if (empty? v) () (concat-lazy n (fn [_] (embed (rand-nth v))))))))))

(defn pxrand
  "(pxrand [a b c] repeats) - random, never the same item twice in a row
   (when the list has more than one distinct item)."
  ([xs] (pxrand xs 1))
  ([xs repeats]
   (let [v (check-list "pxrand" xs) n (reps repeats "pxrand")
         distinct? (> (count (set v)) 1)]
     (mkpat :pxrand
            (fn []
              (if (empty? v)
                ()
                (let [last-item (atom ::none)]
                  (concat-lazy n (fn [_]
                                   (let [choices (if distinct? (filterv #(not= % @last-item) v) v)
                                         x (rand-nth choices)]
                                     (reset! last-item x)
                                     (embed x)))))))))))

(defn pshuf
  "(pshuf [a b c] repeats) - shuffled once per stream, that order repeated."
  ([xs] (pshuf xs 1))
  ([xs repeats]
   (let [v (check-list "pshuf" xs) n (reps repeats "pshuf")]
     (mkpat :pshuf (fn [] (let [order (vec (shuffle v)) c (count order)]
                            (if (zero? c) () (concat-lazy (* n c) (fn [i] (embed (nth order (mod i c))))))))))))

(defn pwrand
  "(pwrand [a b c] [0.5 0.3 0.2] repeats) - weighted random (weights are normalised)."
  ([xs weights] (pwrand xs weights 1))
  ([xs weights repeats]
   (let [v (check-list "pwrand" xs) w (vec weights) n (reps repeats "pwrand")
         total (reduce + 0 w)]
     (when-not (and (= (count v) (count w)) (every? #(and (number? %) (>= % 0)) w) (pos? total))
       (throw (ex-info "pwrand: need one non-negative weight per item, not all zero" {})))
     (let [cum (vec (reductions + (map #(/ % total) w)))]
       (mkpat :pwrand
              (fn [] (concat-lazy n (fn [_]
                                      (let [r (rand)
                                            i (or (first (keep-indexed (fn [i c] (when (< r c) i)) cum)) (dec (count v)))]
                                        (embed (nth v i)))))))))))

;; --- numeric series & noise ----------------------------------------------
(defn pseries
  "(pseries start step length) - start, start+step, ... (length default :inf)"
  ([start step] (pseries start step :inf))
  ([start step length]
   (let [n (reps length "pseries")]
     (mkpat :pseries (fn [] (take n (iterate #(+ % step) start)))))))

(defn pgeom
  "(pgeom start grow length) - start, start*grow, ... (length default :inf)"
  ([start grow] (pgeom start grow :inf))
  ([start grow length]
   (let [n (reps length "pgeom")]
     (mkpat :pgeom (fn [] (take n (iterate #(* % grow) start)))))))

(defn- whole? [x] (and (number? x) (== x (js/Math.floor x))))

(defn pwhite
  "(pwhite lo hi length) - uniform random, inclusive. Whole-number bounds
   give whole numbers (like SC rrand with integers); pass :float as a 4th
   arg to force floats, e.g. (pwhite 0 1 :inf :float)."
  ([lo hi] (pwhite lo hi :inf))
  ([lo hi length] (pwhite lo hi length nil))
  ([lo hi length mode]
   (let [n (reps length "pwhite")
         ints? (and (not= mode :float) (whole? lo) (whole? hi))
         [lo hi] [(min lo hi) (max lo hi)]]
     (mkpat :pwhite
            (fn [] (generate n (fn [] (if ints?
                                        (+ lo (js/Math.floor (* (rand) (inc (- hi lo)))))
                                        (+ lo (* (rand) (- hi lo)))))))))))

(defn pexprand
  "(pexprand lo hi length) - exponentially distributed between lo and hi (same sign, non-zero)."
  ([lo hi] (pexprand lo hi :inf))
  ([lo hi length]
   (when-not (and (number? lo) (number? hi) (pos? (* lo hi)))
     (throw (ex-info "pexprand: lo and hi must be non-zero and the same sign" {})))
   (let [n (reps length "pexprand")]
     (mkpat :pexprand (fn [] (generate n (fn [] (* lo (js/Math.pow (/ hi lo) (rand))))))))))

;; --- structure ---------------------------------------------------------
(defn pn
  "(pn pattern repeats) - play the whole pattern repeats times (default :inf)."
  ([p] (pn p :inf))
  ([p repeats]
   (let [n (reps repeats "pn")]
     (mkpat :pn (fn []
                  (letfn [(step [i] (lazy-seq
                                     (when (< i n)
                                       (let [xs (seq (->seq p))]
                                         ;; an empty pattern repeated forever would never yield
                                         (when xs (concat xs (step (inc i))))))))]
                    (step 0)))))))

(defn pdup
  "(pdup n pattern) - repeat each value n times; n may itself be a pattern."
  [n p]
  (mkpat :pdup
         (fn []
           (letfn [(step [ns xs]
                     (lazy-seq
                      (let [ns (seq ns) xs (seq xs)]
                        (when (and ns xs)
                          (let [k (first ns)]
                            (when-not (and (number? k) (>= k 0))
                              (throw (ex-info (str "pdup: count must be a non-negative number, got " (pr-str k)) {})))
                            (concat (repeat k (first xs)) (step (clojure.core/rest ns) (clojure.core/rest xs))))))))]
             (step (->seq n) (->seq p))))))

(defn pfunc
  "(pfunc f) - calls (f) for every value; f returning nil ends the stream,
   :rest is a rest."
  [f]
  (mkpat :pfunc (fn [] (letfn [(step [] (lazy-seq (let [v (f)] (when (some? v) (cons v (step))))))]
                         (step)))))

;; --- math ----------------------------------------------------------------
(defn- pbinop [kind f]
  (fn pop
    ([a b]
     (mkpat kind (fn [] (map (fn [x y] (if (or (rest? x) (rest? y)) :rest (f x y)))
                             (->seq a) (->seq b)))))
    ([a b & more] (reduce pop (pop a b) more))))

(def p+ (pbinop :p+ +))
(def p- (pbinop :p- -))
(def p* (pbinop :p* *))

;; --- events --------------------------------------------------------------
(defn pbind
  "(pbind :instrument bass :note (pseq [40 nil 43] :inf) :dur 0.5 :amp 0.3)
   Each value is a pattern or a constant. The stream yields event maps and
   ends as soon as any key's stream ends."
  [& kvs]
  (when (or (empty? kvs) (odd? (count kvs)) (not (every? keyword? (take-nth 2 kvs))))
    (throw (ex-info "pbind takes keyword / pattern pairs" {})))
  (let [pairs (vec (partition 2 kvs))]
    (mkpat :pbind
           (fn []
             (letfn [(step [seqs]
                       (lazy-seq
                        (let [ss (mapv (fn [[k s]] [k (seq s)]) seqs)]
                          (when (every? second ss)
                            (cons (into {} (map (fn [[k s]] [k (first s)]) ss))
                                  (step (mapv (fn [[k s]] [k (clojure.core/rest s)]) ss)))))))]
               (step (mapv (fn [[k p]] [k (->seq p)]) pairs)))))))

(def ^:private event-keys #{:instrument :dur :sample :type})

(defn event-rest?
  "An event is a rest if :type is :rest or any value is :rest."
  [e]
  (boolean (or (= :rest (:type e)) (some rest? (vals e)))))

(defn- note-val [v] (if (keyword? v) (note v) v))

(defn- event-params
  "Event keys -> synth params. :midinote becomes :note when the synth has no
   midinote param; keyword notes (:c4) become MIDI numbers; a defsynth only
   gets the params it declares (others are ignored, like SC)."
  [instr e]
  (let [sd (when (fn? instr) (:ovt/synth (meta instr)))
        pnames (when sd (set (map :name (:params sd))))
        e (if (and (contains? e :midinote) (not (contains? e :note))
                   (not (and pnames (pnames "midinote"))))
            (-> e (assoc :note (:midinote e)) (dissoc :midinote))
            e)
        e (cond-> e (contains? e :note) (update :note note-val)
                    (contains? e :midinote) (update :midinote note-val))
        kv (apply dissoc e event-keys)]
    (if pnames
      (into {} (filter (fn [[k _]] (pnames (name k))) kv))
      kv)))

(defn play-event
  "Sound one event now (or inside the enclosing (at ...)). Rests do nothing.
   A vector :note plays a chord."
  [e]
  (when-not (event-rest? e)
    (let [instr (get e :instrument :beep)
          params (event-params instr e)
          one (fn [ps]
                (cond
                  (:sample e) (apply sample (:sample e) (mapcat identity ps))
                  (fn? instr) (instr ps)
                  (or (keyword? instr) (string? instr)) (s-new instr ps)
                  :else (throw (ex-info (str "event :instrument must be a defsynth/definst or a Sonic Pi synth keyword, got " (pr-str instr)) {}))))]
      (if (sequential? (:note params))
        (mapv #(one (assoc params :note %)) (:note params))
        (one params)))))

;; --- players -------------------------------------------------------------
(def players (atom {})) ; id -> {:stream :m :token :beat :pending}
(def ^:private player-count (atom 0))

(def default-metro-atom (atom nil))
(defn default-metro []
  (or @default-metro-atom (reset! default-metro-atom (metro 120))))

(defn- event-dur [id e]
  (let [d (get e :dur 1)]
    (when-not (and (number? d) (pos? d))
      (throw (ex-info (str id ": :dur must be a positive number of beats, got " (pr-str d)) {})))
    d))

(defn- start-player [id pattern m opts]
  (let [token (js/Object.)
        b0 (quant-beat m (:quant opts) (:phase opts))]
    (swap! players assoc id {:stream (as-stream pattern) :m m :token token :pending nil})
    (letfn [(tick [beat]
              (when-let [pl (get @players id)]
                (when (identical? token (:token pl))
                  ;; a quantised swap waiting for this boundary?
                  (when-let [{:keys [stream at-beat]} (:pending pl)]
                    (when (>= beat (- at-beat 1e-9))
                      (swap! players update id assoc :stream stream :pending nil)))
                  (let [{:keys [stream m pending]} (get @players id)]
                    (try
                      (if-let [e (next stream)]
                        (let [d (event-dur id e)
                              nb (+ beat d)
                              nb (if (and pending (> nb (:at-beat pending))) (:at-beat pending) nb)]
                          (at (m beat) (play-event e))
                          (swap! players update id assoc :beat nb)
                          (apply-by (m nb) tick nb))
                        (if pending
                          ;; old pattern ran out before the boundary: wait for it
                          (apply-by (m (:at-beat pending)) tick (:at-beat pending))
                          (swap! players dissoc id)))
                      (catch :default e
                        (swap! players dissoc id)
                        (.log js/ovt "error" (str "pdef " id " stopped at beat " beat ": " (ex-message e)))))))))]
      (swap! players update id assoc :beat b0)
      (apply-by (m b0) tick b0))
    b0))

(defn- player-opts [who opts default-m]
  (check-quant-opts who opts)
  (let [m (or (:metro opts) default-m (default-metro))]
    (when-not (fn? m) (throw (ex-info (str who ": :metro must be a metro from (metro bpm)") {})))
    m))

(defn pdef
  "(pdef :bass (pbind ...) {:metro m :quant 4 :phase 0})
   Starts playing (first event on the next multiple of :quant beats).
   Re-evaluating the same id swaps the pattern from the next event on,
   keeping the beat grid; pass :quant again to swap on that boundary.
   Without :metro a default 120 bpm metro is used."
  ([id pattern] (pdef id pattern {}))
  ([id pattern opts]
   (let [pl (get @players id)
         m (player-opts "pdef" opts (:m pl))]
     (if pl
       (let [s (as-stream pattern)]
         (if-let [q (:quant opts)]
           (let [;; first boundary at or after the player's next unsent event
                 b (quant-beat m q (:phase opts) (max (m) (or (:beat pl) 0)))]
             (swap! players update id assoc :pending {:stream s :at-beat b} :m m)
             [:swapping id :at-beat b])
           (do (swap! players update id assoc :stream s :pending nil :m m)
               [:updated id])))
       (do (start-player id pattern m opts)
           [:started id])))))

(defn pplay
  "Anonymous player: (pplay (pbind ...) {:metro m :quant 4}). Returns a handle for pstop."
  ([pattern] (pplay pattern {}))
  ([pattern opts]
   (let [m (player-opts "pplay" opts nil)
         id (keyword (str "pplay-" (swap! player-count inc)))]
     (start-player id pattern m opts)
     {:ovt/type :player :id id})))

(defn pstop
  "(pstop :bass) or (pstop handle-from-pplay). Already-sent bundles
   (at most the lookahead, ~300 ms) still play; (stop) clears everything."
  [x]
  (let [id (if (map? x) (:id x) x)]
    (swap! players dissoc id)
    [:stopped id]))

(defn running-pdefs [] (vec (keys @players)))

(defn stop
  "Silence everything: cancels loops, pdefs/pplays and pending timers, drops
   scheduled bundles (purge + /clearSched), and deep-frees every synth."
  []
  (reset! loops {})
  (reset! players {})
  (.stop js/ovt)
  :stopped)

(def ^:private help-base help)
(defn help []
  (str (help-base) "\n"
       "patterns: (pseq [..] n) prand pxrand pshuf (pwrand [..] [w..]) (pseries 0 2 8) pgeom (pwhite lo hi) pexprand\n"
       "          (pn p n) (pdup n p) (pfunc f) (p+ p 40) p- p*  (as-stream p) (next s) (next-n s 8) (reset s)  nil = rest\n"
       "players:  (pdef :bass (pbind :instrument pluck-bass :note (pseq [40 nil 43] :inf) :dur 0.5) {:metro m :quant 4})\n"
       "          re-eval pdef to swap live, (pplay pat {:metro m}) (pstop :bass) (running-pdefs)  loops take {:quant 4} too"))

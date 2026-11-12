;; ---------------------------------------------------------------------
;; Synth definition: defsynth / synth / definst / demo
;; ---------------------------------------------------------------------
(ns user)

(defn- param-default [sym d]
  (let [d (if (map? d) (:default d 0) d)]
    (when-not (number? d)
      (throw (ex-info (str "param " sym " needs a number default, got " (pr-str d)) {})))
    d))

(defn- has-out? [nodes]
  (some #(#{"Out" "ReplaceOut" "OffsetOut"} (:name %)) nodes))

(defn- stereo [sig]
  (cond
    (not (sequential? sig)) [sig sig]
    (= 1 (count sig)) [(first sig) (first sig)]
    :else sig))

(defn- check-result [sname sig]
  (when-not (or (ugen? sig) (param? sig) (and (sequential? sig) (seq sig)))
    (throw (ex-info (str sname ": synth body must return a ugen (or vector of ugens), got "
                         (pr-str sig)
                         (when (number? sig) " - note that clojure.core math on ugens gives NaN outside synth bodies; use u* u+ or defcgen"))
                    {}))))

(def demo-count (atom 0))

(defn- ->graph-js [sname params nodes]
  (clj->js {:name sname
            :params (mapv (fn [p] {:name (:name p) :default (:default p)}) params)
            :ugens (mapv (fn [n] (select-keys n [:id :name :rate :special :numOutputs :inputs])) nodes)}))

(defn compile-synth
  "Build the ugen graph by running f with param proxies. Returns
   {:name :params :nodes :bytes}. opts: :demo seconds, :inst true"
  [sname pnames defaults f opts]
  (let [params (mapv (fn [s d] {:ovt/type :param :name (name s) :rate 1 :default (param-default s d)})
                     pnames defaults)
        g (atom {:nodes []})]
    (binding [*graph* g]
      (let [sig (apply f params)
            nodes (:nodes @g)]
        (when (or (:demo opts) (not (has-out? nodes)))
          (when-not (has-out? nodes) (check-result sname sig))
          (let [dur (:demo opts)
                sig (if (and dur (not (has-out? nodes)))
                      (u* sig (env-gen (lin 0.01 (max 0 (- dur 0.06)) 0.05)))
                      sig)]
            (when dur (line:kr 0 0 dur FREE)) ; free the node after dur
            (when-not (has-out? (:nodes @g))
              (out 0 (stereo sig)))))))
    (let [nodes (:nodes @g)
          bytes (try
                  (.compileSynthDef js/ovt (->graph-js sname params nodes))
                  (catch :default e
                    (throw (ex-info (str "could not compile synth " sname ": " (ex-message e)) {}))))]
      {:ovt/type :synth :name sname :params (mapv #(select-keys % [:name :default]) params)
       :ugens (mapv :name nodes) :bytes bytes :inst (:inst opts)})))



(defn- placement
  "[:head g] [:tail g] [:before n] [:after n] [:replace n] -> [add-action target]"
  [pos]
  (let [[where target] pos
        action ({:head 0 :tail 1 :before 2 :after 3 :replace 4} where)]
    (when-not (and action (some? target))
      (throw (ex-info (str "position must be like [:head group] [:tail group] [:before node] [:after node], got " (pr-str pos)) {})))
    [action (if (map? target) (:id target) target)]))

(defn- inst-group [sdef]
  (or (get @inst-groups (:name sdef))
      (let [g (.newGroup js/ovt 1 0 true)] ; tail of root, sent immediately
        (swap! inst-groups assoc (:name sdef) g)
        g)))

(defn- spawn [sdef args]
  (let [[pos args] (if (vector? (first args)) [(first args) (rest args)] [nil args])
        [action target] (cond pos (placement pos)
                              (:inst sdef) [0 (inst-group sdef)]
                              :else [0 0])
        args (if (and (= 1 (count args)) (map? (first args))) (mapcat identity (first args)) args)
        [positional kws] (split-with (complement keyword?) args)
        pnames (mapv :name (:params sdef))
        _ (when (> (count positional) (count pnames))
            (throw (ex-info (str (:name sdef) " takes params " pnames) {})))
        kv (concat (mapcat (fn [n v] [n v]) pnames positional)
                   (flat-params kws))]
    (doseq [[k _] (partition 2 kv)]
      (when-not (some #{k} pnames)
        (throw (ex-info (str (:name sdef) " has no param " k "; params are " pnames) {}))))
    (.sNew js/ovt (:name sdef) (clj->js (vec kv)) action target)))

(defn synth-def [x] (:ovt/synth (meta x)))

(defn register-synth [sdef]
  (.defineSynth js/ovt (:name sdef) (:bytes sdef))
  (with-meta (fn [& args] (spawn sdef args))
    {:ovt/synth (dissoc sdef :bytes)}))

(defn- math-bindings []
  ['+ 'user/u+ '- 'user/u- '* 'user/u* '/ 'user/u-div 'min 'user/umin 'max 'user/umax
   'mod 'user/umod 'abs 'user/uabs 'rand 'user/ugen-rand 'sqrt 'user/usqrt 'exp 'user/uexp
   'floor 'user/ufloor 'pow 'user/upow '< 'user/u< '> 'user/u>])

(defn- synth-form [sname params body opts]
  (let [pairs (partition 2 params)
        syms (mapv first pairs)
        defaults (mapv second pairs)]
    (when (odd? (count params))
      (throw (ex-info (str sname ": params must be [name default ...]") {})))
    `(register-synth
      (compile-synth ~sname '~syms ~defaults
                     (fn [~@syms] (let [~@(math-bindings)] ~@body))
                     ~opts))))

(defmacro synth
  "(synth [freq 440] (sin-osc freq)) => anonymous synth fn; call it to play."
  [& form]
  (let [[sname form] (if (string? (first form)) [(first form) (rest form)] [nil form])
        [params & body] form]
    (synth-form (or sname (str "anon-" (swap! demo-count inc))) params body {})))

(defmacro defsynth
  "(defsynth name [param default ...] body) - compiles to a SynthDef, sends it to
   the engine (/d_recv), and defines name as a fn: (name 220) (name :freq 220)
   (name [:tail g] :freq 220). Returns node ids for ctl / kill."
  [sname & form]
  (let [[_doc form] (if (string? (first form)) [(first form) (rest form)] [nil form])
        [params & body] form]
    `(def ~sname ~(synth-form (name sname) params body {}))))

(defmacro definst
  "Like defsynth, but every node goes into the instrument's own group, so
   (ctl inst :param v) and (kill inst) reach all its running notes."
  [sname & form]
  (let [[_doc form] (if (string? (first form)) [(first form) (rest form)] [nil form])
        [params & body] form]
    `(def ~sname ~(synth-form (name sname) params body {:inst true}))))

(defmacro demo
  "(demo body) or (demo seconds body): compile and play for a while (default 2s)."
  [& body]
  (let [[dur body] (if (and (number? (first body)) (next body)) [(first body) (rest body)] [2 body])]
    `((register-synth
       (compile-synth (str "ovt-demo-" (mod (swap! user/demo-count inc) 256)) [] []
                      (fn [] (let [~@(math-bindings)] ~@body))
                      {:demo ~dur})))))

(defmacro defcgen
  "Define a helper fn whose body uses ugen math (+ - * / work on ugens):
   (defcgen detuned [f] (mix (saw [f (* f 1.01)])))"
  [fname args & body]
  `(defn ~fname ~args (let [~@(math-bindings)] ~@body)))

;; --- groups, buses -----------------------------------------------------
(defn group
  "(group) (group :tail target) (group [:after node]) => group id"
  ([] (.newGroup js/ovt 0 0 false))
  ([pos] (let [[a t] (placement pos)] (.newGroup js/ovt a t false)))
  ([where target] (group [where target])))

(def ^:private next-audio-bus (atom 16))   ; 0-1 out, 2-3 in, leave headroom
(def ^:private next-control-bus (atom 0))

(defn audio-bus
  "Reserve n consecutive private audio buses; returns the first index."
  ([] (audio-bus 1))
  ([n] (let [b @next-audio-bus] (swap! next-audio-bus + n) b)))

(defn control-bus
  ([] (control-bus 1))
  ([n] (let [b @next-control-bus] (swap! next-control-bus + n) b)))

(defn control-bus-set! [bus value] (send "/c_set" bus value))

;; --- samples -------------------------------------------------------------
(def samples (atom {})) ; name -> buffer

(defn load-sample
  "(load-sample :bd_haus) or (load-sample \"loop_amen\") - Sonic Pi's samples
   (supersonic-scsynth-samples). Returns a promise of the buffer map."
  [nm]
  (let [k (name nm)]
    (if-let [b (get @samples k)]
      (js/Promise.resolve b)
      (-> (.loadSample js/ovt k)
          (.then (fn [r]
                   (let [b {:ovt/type :buffer :id (.-id r) :name k :frames (.-frames r)
                            :channels (.-channels r) :rate (.-rate r) :duration (.-duration r)}]
                     (swap! samples assoc k b)
                     b)))))))

(defsynth ovt-sample-1 [buf 0 rate 1 amp 1 pan 0 start 0 loop 0]
  (pan2 (* amp (play-buf 1 buf (* rate (buf-rate-scale:kr buf)) 1 start loop FREE)) pan))
(defsynth ovt-sample-2 [buf 0 rate 1 amp 1 pan 0 start 0 loop 0]
  (let [[l r] (play-buf 2 buf (* rate (buf-rate-scale:kr buf)) 1 start loop FREE)]
    (balance2 (* amp l) (* amp r) pan)))

(defn sample-player
  "Play a loaded buffer: (sample-player buf :rate 0.5 :amp 0.8 :pan -0.3)"
  [buf & params]
  (when-not (buffer? buf) (throw (ex-info "sample-player needs a buffer from load-sample" {})))
  (apply (if (= 2 (:channels buf)) ovt-sample-2 ovt-sample-1) :buf (:id buf) params))

(defn sample
  "(sample :bd_haus :rate 1 :amp 1) plays a Sonic Pi sample. If it isn't loaded
   yet it is loaded first (and played when ready, unless inside (at ...))."
  [nm & params]
  (if-let [b (get @samples (name nm))]
    (apply sample-player b params)
    (if (.inBundle js/ovt)
      (do (load-sample nm)
          (.log js/ovt "info" (str "loading sample " (name nm) "; it will play from the next scheduled hit"))
          nil)
      (.then (load-sample nm) (fn [b] (apply sample-player b params))))))

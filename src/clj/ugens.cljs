;; ---------------------------------------------------------------------
;; UGen graph builder: Overtone-flavoured ugen functions that build a
;; graph (data) while a synth body runs. The JS side (src/synthdef.js)
;; serialises the graph to SuperCollider's SynthDef v2 format.
;; ---------------------------------------------------------------------
(ns user)

(def ^:dynamic *graph* nil) ; atom {:nodes [...]} while a synth body runs

(def rate-num {:ir 0 :kr 1 :ar 2 :dr 3})
(def FREE 2)
(def NO-ACTION 0)
(def PAUSE 1)
(def FREE-AND-BEFORE 3) ; frees this node and the one before it

(defn ugen? [x] (and (map? x) (= :ugen (:ovt/type x))))
(defn param? [x] (and (map? x) (= :param (:ovt/type x))))
(defn buffer? [x] (and (map? x) (= :buffer (:ovt/type x))))
(defn env? [x] (and (map? x) (= :env (:ovt/type x))))
(defn- sig? [x] (or (ugen? x) (param? x)))

(defn- rate-of [x] (if (sig? x) (:rate x) 0))

(defn- in-graph! [what]
  (when-not *graph*
    (throw (ex-info (str what " is a ugen: use it inside defsynth, synth, definst or demo") {}))))

(defn- add-node! [sc-name rate special num-outputs inputs]
  (in-graph! sc-name)
  (let [id (count (:nodes @*graph*))
        proxy (fn [i] {:ovt/type :ugen :id id :name sc-name :rate rate :output i})]
    (swap! *graph* update :nodes conj
           {:id id :name sc-name :rate rate :special special
            :numOutputs num-outputs :inputs inputs})
    (case num-outputs
      0 (assoc (proxy 0) :no-output true)
      1 (proxy 0)
      (mapv proxy (range num-outputs)))))

(defn- ->input [owner x]
  (cond
    (number? x) {:constant x}
    (true? x) {:constant 1}
    (false? x) {:constant 0}
    (buffer? x) {:constant (:id x)}
    (param? x) {:param (:name x)}
    (and (ugen? x) (:no-output x))
    (throw (ex-info (str owner ": " (:name x) " has no output to read") {}))
    (ugen? x) {:ugen (:id x) :output (:output x)}
    (nil? x) (throw (ex-info (str owner ": missing input") {}))
    :else (throw (ex-info (str owner ": can't use " (pr-str x) " as a ugen input") {}))))

(declare ugen-dc ugen-k2a)

(defn- ->ar
  "Audio-rate inputs of audio-rate ugens must be audio signals."
  [x]
  (cond
    (sequential? x) (mapv ->ar x)
    (and (sig? x) (= 2 (:rate x))) x
    (sig? x) (ugen-k2a x)
    (number? x) (ugen-dc x)
    (buffer? x) (ugen-dc (:id x))
    :else x))

;; --- multichannel expansion --------------------------------------------
(defn- expand
  "If any value in m (for the given keys) is a vector, build one ugen per
   channel (wrapping shorter vectors), Overtone/SC style."
  [m ks build1]
  (let [widths (keep (fn [k] (let [v (get m k)] (when (sequential? v) (count v)))) ks)]
    (cond
      (empty? widths) (build1 m)
      (some zero? widths) (throw (ex-info "empty vector given as a ugen input" {}))
      :else (mapv (fn [i]
                    (expand (reduce (fn [m k]
                                      (let [v (get m k)]
                                        (if (sequential? v) (assoc m k (nth v (mod i (count v)))) m)))
                                    m ks)
                            ks build1))
                  (range (apply max widths))))))

(defn- parse-args [spec args]
  (let [fname (:fname spec)
        names (mapv first (:args spec))
        [pos kw] (split-with (complement keyword?) args)
        _ (when (> (count pos) (count names))
            (throw (ex-info (str fname " takes at most " (count names) " args " names) {})))
        _ (when (odd? (count kw))
            (throw (ex-info (str fname ": keyword args must come in pairs") {})))
        kwm (apply hash-map kw)
        kwm (if (and (contains? kwm :done-action) (some #{:action} names))
              (-> kwm (assoc :action (:done-action kwm)) (dissoc :done-action)) kwm)
        unknown (remove (set names) (keys kwm))]
    (when (seq unknown)
      (throw (ex-info (str fname " has no arg " (pr-str (first unknown)) "; args are " names) {})))
    (into {}
          (map-indexed
           (fn [i [n default]]
             (let [v (cond (< i (count pos)) (nth pos i)
                           (contains? kwm n) (get kwm n)
                           :else default)]
               (when (nil? v)
                 (throw (ex-info (str fname " needs " n) {})))
               [n v]))
           (:args spec)))))

(defn- splice-values [spec rate v]
  (cond
    (env? v) (:data v)
    (= :channels (:splice spec)) (let [xs (if (sequential? v) (flatten v) [v])]
                                   (if (= rate 2) (map ->ar xs) xs))
    (sequential? v) (flatten v)
    :else [v]))

(defn- build-map [spec rate m]
  (let [rn (rate-num rate)
        input-order (or (:inputs spec) (remove #{(:outputs-arg spec)} (map first (:args spec))))
        splice (:splice spec)
        chans (get m splice)]
    (if (and (= :channels splice) (sequential? chans) (seq chans) (every? sequential? chans))
      ;; (out 0 [[l r] [l r]]): one Out per inner vector; they sum on the bus
      (mapv #(build-map spec rate (assoc m splice %)) chans)
      (let [audio (set (:audio-inputs spec))]
        (expand m (vec (remove #{splice} input-order))
                (fn [m]
                  (let [num-out (if-let [oa (:outputs-arg spec)]
                                  (let [n (get m oa)]
                                    (when-not (and (number? n) (pos? n))
                                      (throw (ex-info (str (:fname spec) ": " oa " must be a positive number") {})))
                                    (int n))
                                  (:outputs spec 1))
                        inputs (vec (mapcat
                                     (fn [k]
                                       (let [v (get m k)]
                                         (if (= k splice)
                                           (map #(->input (:sc spec) %) (splice-values spec rn v))
                                           [(->input (:sc spec) (if (and (= rn 2) (audio k)) (->ar v) v))])))
                                     input-order))]
                    (add-node! (:sc spec) rn (:special spec 0) num-out inputs))))))))

(defn build-ugen [spec rate args]
  (build-map spec rate (parse-args spec args)))

(def ugen-registry (atom (sorted-map)))

(defmacro defugens
  "[name SCName [rates...] [[arg default]...] & opts]"
  [& entries]
  `(do
     ~@(for [[sym sc rates args & opts] entries
             :let [opts (apply hash-map opts)
                   spec (merge {:sc sc :rates rates :args args :fname (str sym)} opts)
                   fnames (cons [sym (first rates)]
                                (map (fn [r] [(symbol (str sym ":" (name r))) r]) rates))]
             form (concat
                   (for [[fname r] fnames]
                     `(defn ~fname [& args#] (build-ugen '~spec ~r args#)))
                   [`(swap! ugen-registry assoc ~(str sym) '~spec)])]
         form)))

(defugens
  ;; oscillators
  [sin-osc "SinOsc" [:ar :kr] [[:freq 440] [:phase 0]]]
  [saw "Saw" [:ar :kr] [[:freq 440]]]
  [pulse "Pulse" [:ar :kr] [[:freq 440] [:width 0.5]]]
  [lf-saw "LFSaw" [:ar :kr] [[:freq 440] [:iphase 0]]]
  [lf-tri "LFTri" [:ar :kr] [[:freq 440] [:iphase 0]]]
  [lf-par "LFPar" [:ar :kr] [[:freq 440] [:iphase 0]]]
  [lf-cub "LFCub" [:ar :kr] [[:freq 440] [:iphase 0]]]
  [lf-pulse "LFPulse" [:ar :kr] [[:freq 440] [:iphase 0] [:width 0.5]]]
  [var-saw "VarSaw" [:ar :kr] [[:freq 440] [:iphase 0] [:width 0.5]]]
  [sync-saw "SyncSaw" [:ar :kr] [[:sync-freq 440] [:saw-freq 440]]]
  [blip "Blip" [:ar :kr] [[:freq 440] [:numharm 200]]]
  [fsin-osc "FSinOsc" [:ar :kr] [[:freq 440] [:iphase 0]]]
  [sin-osc-fb "SinOscFB" [:ar :kr] [[:freq 440] [:feedback 0]]]
  [formant "Formant" [:ar] [[:fundfreq 440] [:formfreq 1760] [:bwfreq 880]]]
  [impulse "Impulse" [:ar :kr] [[:freq 440] [:phase 0]]]
  [dust "Dust" [:ar :kr] [[:density 0]]]
  [dust2 "Dust2" [:ar :kr] [[:density 0]]]
  [lf-noise0 "LFNoise0" [:ar :kr] [[:freq 500]]]
  [lf-noise1 "LFNoise1" [:ar :kr] [[:freq 500]]]
  [lf-noise2 "LFNoise2" [:ar :kr] [[:freq 500]]]
  [white-noise "WhiteNoise" [:ar :kr] []]
  [pink-noise "PinkNoise" [:ar :kr] []]
  [brown-noise "BrownNoise" [:ar :kr] []]
  [gray-noise "GrayNoise" [:ar :kr] []]
  [clip-noise "ClipNoise" [:ar :kr] []]
  [crackle "Crackle" [:ar :kr] [[:chaos-param 1.5]]]
  ;; filters
  [lpf "LPF" [:ar :kr] [[:in] [:freq 440]] :audio-inputs [:in]]
  [hpf "HPF" [:ar :kr] [[:in] [:freq 440]] :audio-inputs [:in]]
  [rlpf "RLPF" [:ar :kr] [[:in] [:freq 440] [:rq 1]] :audio-inputs [:in]]
  [rhpf "RHPF" [:ar :kr] [[:in] [:freq 440] [:rq 1]] :audio-inputs [:in]]
  [bpf "BPF" [:ar :kr] [[:in] [:freq 440] [:rq 1]] :audio-inputs [:in]]
  [brf "BRF" [:ar :kr] [[:in] [:freq 440] [:rq 1]] :audio-inputs [:in]]
  [resonz "Resonz" [:ar :kr] [[:in] [:freq 440] [:bwr 1]] :audio-inputs [:in]]
  [ringz "Ringz" [:ar :kr] [[:in] [:freq 440] [:decay-time 1]] :audio-inputs [:in]]
  [moog-ff "MoogFF" [:ar :kr] [[:in] [:freq 100] [:gain 2] [:reset 0]] :audio-inputs [:in]]
  [one-pole "OnePole" [:ar :kr] [[:in] [:coef 0.5]] :audio-inputs [:in]]
  [leak-dc "LeakDC" [:ar :kr] [[:in] [:coef 0.995]] :audio-inputs [:in]]
  [lag "Lag" [:ar :kr] [[:in] [:lag-time 0.1]] :audio-inputs [:in]]
  [lag-ud "LagUD" [:ar :kr] [[:in] [:lag-time-u 0.1] [:lag-time-d 0.1]] :audio-inputs [:in]]
  [decay "Decay" [:ar :kr] [[:in] [:decay-time 1]] :audio-inputs [:in]]
  [decay2 "Decay2" [:ar :kr] [[:in] [:attack-time 0.01] [:decay-time 1]] :audio-inputs [:in]]
  [comb-n "CombN" [:ar :kr] [[:in] [:max-delay-time 0.2] [:delay-time 0.2] [:decay-time 1]] :audio-inputs [:in]]
  [comb-l "CombL" [:ar :kr] [[:in] [:max-delay-time 0.2] [:delay-time 0.2] [:decay-time 1]] :audio-inputs [:in]]
  [comb-c "CombC" [:ar :kr] [[:in] [:max-delay-time 0.2] [:delay-time 0.2] [:decay-time 1]] :audio-inputs [:in]]
  [allpass-n "AllpassN" [:ar :kr] [[:in] [:max-delay-time 0.2] [:delay-time 0.2] [:decay-time 1]] :audio-inputs [:in]]
  [allpass-c "AllpassC" [:ar :kr] [[:in] [:max-delay-time 0.2] [:delay-time 0.2] [:decay-time 1]] :audio-inputs [:in]]
  [delay-n "DelayN" [:ar :kr] [[:in] [:max-delay-time 0.2] [:delay-time 0.2]] :audio-inputs [:in]]
  [delay-l "DelayL" [:ar :kr] [[:in] [:max-delay-time 0.2] [:delay-time 0.2]] :audio-inputs [:in]]
  [delay-c "DelayC" [:ar :kr] [[:in] [:max-delay-time 0.2] [:delay-time 0.2]] :audio-inputs [:in]]
  [pluck "Pluck" [:ar] [[:in] [:trig 1] [:max-delay-time 0.2] [:delay-time 0.2] [:decay-time 1] [:coef 0.5]] :audio-inputs [:in]]
  [free-verb "FreeVerb" [:ar] [[:in] [:mix 0.33] [:room 0.5] [:damp 0.5]] :audio-inputs [:in]]
  [free-verb2 "FreeVerb2" [:ar] [[:in] [:in2] [:mix 0.33] [:room 0.5] [:damp 0.5]] :audio-inputs [:in :in2] :outputs 2]
  [g-verb "GVerb" [:ar] [[:in] [:roomsize 10] [:revtime 3] [:damping 0.5] [:inputbw 0.5] [:spread 15]
                         [:drylevel 1] [:earlyreflevel 0.7] [:taillevel 0.5] [:maxroomsize 300]] :audio-inputs [:in] :outputs 2]
  [pitch-shift "PitchShift" [:ar] [[:in] [:window-size 0.2] [:pitch-ratio 1] [:pitch-dispersion 0] [:time-dispersion 0]] :audio-inputs [:in]]
  [limiter "Limiter" [:ar] [[:in] [:level 1] [:dur 0.01]] :audio-inputs [:in]]
  [normalizer "Normalizer" [:ar] [[:in] [:level 1] [:dur 0.01]] :audio-inputs [:in]]
  ;; panning / mixing
  [pan2 "Pan2" [:ar :kr] [[:in] [:pos 0] [:level 1]] :audio-inputs [:in] :outputs 2]
  [balance2 "Balance2" [:ar :kr] [[:left] [:right] [:pos 0] [:level 1]] :audio-inputs [:left :right] :outputs 2]
  [x-fade2 "XFade2" [:ar :kr] [[:in-a] [:in-b 0] [:pan 0] [:level 1]] :audio-inputs [:in-a :in-b]]
  ;; envelopes, lines, done
  [line "Line" [:ar :kr] [[:start 0] [:end 1] [:dur 1] [:action 0]]]
  [x-line "XLine" [:ar :kr] [[:start 1] [:end 2] [:dur 1] [:action 0]]]
  [env-gen "EnvGen" [:ar :kr] [[:envelope] [:gate 1] [:level-scale 1] [:level-bias 0] [:time-scale 1] [:action 0]]
   :inputs [:gate :level-scale :level-bias :time-scale :action :envelope] :splice :envelope]
  [linen "Linen" [:kr] [[:gate 1] [:attack-time 0.01] [:sus-level 1] [:release-time 1] [:action 0]]]
  [phasor "Phasor" [:ar :kr] [[:trig 0] [:rate 1] [:start 0] [:end 1] [:reset-pos 0]]]
  [detect-silence "DetectSilence" [:ar :kr] [[:in] [:amp 0.0001] [:time 0.1] [:action 0]] :audio-inputs [:in]]
  [free-self "FreeSelf" [:kr] [[:in]]]
  [done "Done" [:kr] [[:src]]]
  [free-self-when-done "FreeSelfWhenDone" [:kr] [[:src]]]
  ;; triggers, random, sample & hold
  [ugen-rand "Rand" [:ir] [[:lo 0] [:hi 1]]]
  [exp-rand "ExpRand" [:ir] [[:lo 0.01] [:hi 1]]]
  [i-rand "IRand" [:ir] [[:lo 0] [:hi 127]]]
  [t-rand "TRand" [:kr :ar] [[:lo 0] [:hi 1] [:trig 0]]]
  [t-exp-rand "TExpRand" [:kr :ar] [[:lo 0.01] [:hi 1] [:trig 0]]]
  [latch "Latch" [:ar :kr] [[:in 0] [:trig 0]]]
  [trig "Trig" [:ar :kr] [[:in 0] [:dur 0.1]]]
  [trig1 "Trig1" [:ar :kr] [[:in 0] [:dur 0.1]]]
  [toggle-ff "ToggleFF" [:ar :kr] [[:trig 0]]]
  [pulse-count "PulseCount" [:ar :kr] [[:trig 0] [:reset 0]]]
  [stepper "Stepper" [:ar :kr] [[:trig 0] [:reset 0] [:min 0] [:max 7] [:step 1] [:resetval 0]]]
  [select "Select" [:ar :kr] [[:which] [:array]] :splice :array]
  ;; ranges / conversions
  [clip "Clip" [:ar :kr] [[:in 0] [:lo 0] [:hi 1]]]
  [wrap "Wrap" [:ar :kr] [[:in 0] [:lo 0] [:hi 1]]]
  [fold "Fold" [:ar :kr] [[:in 0] [:lo 0] [:hi 1]]]
  [lin-exp "LinExp" [:ar :kr] [[:in 0] [:srclo 0] [:srchi 1] [:dstlo 1] [:dsthi 2]]]
  [mul-add "MulAdd" [:ar :kr] [[:in] [:mul 1] [:add 0]]]
  [ugen-k2a "K2A" [:ar] [[:in 0]]]
  [a2k "A2K" [:kr] [[:in 0]]]
  [ugen-dc "DC" [:ar :kr] [[:in 0]]]
  ;; bus i/o
  [out "Out" [:ar :kr] [[:bus 0] [:channels]] :splice :channels :outputs 0]
  [replace-out "ReplaceOut" [:ar :kr] [[:bus 0] [:channels]] :splice :channels :outputs 0]
  [offset-out "OffsetOut" [:ar] [[:bus 0] [:channels]] :splice :channels :outputs 0]
  [in "In" [:ar :kr] [[:bus 0] [:num-channels 1]] :outputs-arg :num-channels]
  ;; buffers
  [play-buf "PlayBuf" [:ar :kr] [[:num-channels 1] [:bufnum 0] [:rate 1] [:trigger 1] [:start-pos 0] [:loop 0] [:action 0]]
   :outputs-arg :num-channels]
  [buf-rd "BufRd" [:ar :kr] [[:num-channels 1] [:bufnum 0] [:phase 0] [:loop 1] [:interpolation 2]] :outputs-arg :num-channels]
  [buf-rate-scale "BufRateScale" [:kr :ir] [[:bufnum 0]]]
  [buf-frames "BufFrames" [:kr :ir] [[:bufnum 0]]]
  [buf-dur "BufDur" [:kr :ir] [[:bufnum 0]]]
  ;; info
  [sample-rate "SampleRate" [:ir] []]
  [sample-dur "SampleDur" [:ir] []]
  [control-rate "ControlRate" [:ir] []])

(def k2a ugen-k2a)
(def dc ugen-dc)

;; --- operators -------------------------------------------------------
(defn- binop [sym special f a b]
  (cond
    (and (number? a) (number? b)) (f a b)
    (or (sequential? a) (sequential? b))
    (let [as (if (sequential? a) (vec a) [a])
          bs (if (sequential? b) (vec b) [b])]
      (when (or (empty? as) (empty? bs)) (throw (ex-info (str sym ": empty vector") {})))
      (mapv (fn [i] (binop sym special f (nth as (mod i (count as))) (nth bs (mod i (count bs)))))
            (range (max (count as) (count bs)))))
    :else
    (add-node! "BinaryOpUGen" (max (rate-of a) (rate-of b)) special 1
               [(->input (str sym) a) (->input (str sym) b)])))

(defn- unop [sym special f a]
  (cond
    (number? a) (f a)
    (sequential? a) (mapv #(unop sym special f %) a)
    :else (add-node! "UnaryOpUGen" (rate-of a) special 1 [(->input (str sym) a)])))

(defn u+
  ([] 0) ([a] a)
  ([a b] (cond (and (number? a) (zero? a)) b (and (number? b) (zero? b)) a :else (binop '+ 0 + a b)))
  ([a b & more] (reduce u+ (u+ a b) more)))
(defn u-
  ([a] (unop '- 0 - a))
  ([a b] (if (and (number? b) (zero? b)) a (binop '- 1 - a b)))
  ([a b & more] (reduce u- (u- a b) more)))
(defn u*
  ([] 1) ([a] a)
  ([a b] (cond (and (number? a) (== 1 a)) b (and (number? b) (== 1 b)) a :else (binop '* 2 * a b)))
  ([a b & more] (reduce u* (u* a b) more)))
(defn u-div
  ([a] (u-div 1 a))
  ([a b] (if (and (number? b) (== 1 b)) a (binop '/ 4 / a b)))
  ([a b & more] (reduce u-div (u-div a b) more)))
(defn umod [a b] (binop 'mod 5 mod a b))
(defn umin ([a] a) ([a b] (binop 'min 12 min a b)) ([a b & more] (reduce umin (umin a b) more)))
(defn umax ([a] a) ([a b] (binop 'max 13 max a b)) ([a b & more] (reduce umax (umax a b) more)))
(defn upow [a b] (binop 'pow 25 #(js/Math.pow %1 %2) a b))
(defn u< [a b] (binop '< 8 #(if (< %1 %2) 1 0) a b))
(defn u> [a b] (binop '> 9 #(if (> %1 %2) 1 0) a b))
(defn clip2 [a b] (binop 'clip2 42 #(max (- %2) (min %2 %1)) a b))
(defn fold2 [a b] (binop 'fold2 44 (fn [_ _] (throw (ex-info "fold2 needs a ugen" {}))) a b))
(defn wrap2 [a b] (binop 'wrap2 45 (fn [_ _] (throw (ex-info "wrap2 needs a ugen" {}))) a b))
(defn absdif [a b] (binop 'absdif 38 #(js/Math.abs (- %1 %2)) a b))

(defn uabs [a] (unop 'abs 5 js/Math.abs a))
(defn midicps [a] (unop 'midicps 17 #(* 440 (js/Math.pow 2 (/ (- % 69) 12))) a))
(defn cpsmidi [a] (unop 'cpsmidi 18 #(+ 69 (* 12 (js/Math.log2 (/ % 440)))) a))
(defn midiratio [a] (unop 'midiratio 19 #(js/Math.pow 2 (/ % 12)) a))
(defn ratiomidi [a] (unop 'ratiomidi 20 #(* 12 (js/Math.log2 %)) a))
(defn dbamp [a] (unop 'dbamp 21 #(js/Math.pow 10 (/ % 20)) a))
(defn ampdb [a] (unop 'ampdb 22 #(* 20 (js/Math.log10 %)) a))
(defn squared [a] (unop 'squared 12 #(* % %) a))
(defn cubed [a] (unop 'cubed 13 #(* % % %) a))
(defn usqrt [a] (unop 'sqrt 14 js/Math.sqrt a))
(defn uexp [a] (unop 'exp 15 js/Math.exp a))
(defn reciprocal [a] (unop 'reciprocal 16 #(/ 1 %) a))
(defn tanh [a] (unop 'tanh 36 js/Math.tanh a))
(defn distort [a] (unop 'distort 42 #(/ % (+ 1 (js/Math.abs %))) a))
(defn softclip [a] (unop 'softclip 43 (fn [x] (let [ax (js/Math.abs x)] (if (<= ax 0.5) x (/ (- ax 0.25) x)))) a))
(defn ufloor [a] (unop 'floor 9 js/Math.floor a))
(def midi->hz midicps)
(def hz->midi cpsmidi)

(defn mix
  "Sum a vector of channels into one."
  [xs]
  (if (sequential? xs) (reduce u+ (flatten xs)) xs))

(defn splay
  "Spread a vector of mono signals across the stereo field."
  [xs]
  (if-not (sequential? xs)
    (pan2 xs)
    (let [n (count xs)]
      (if (= n 1)
        (pan2 (first xs))
        (let [chans (map-indexed (fn [i x] (pan2 x (- (* 2 (/ i (dec n))) 1) (/ 1 (js/Math.sqrt n)))) xs)]
          [(reduce u+ (map first chans)) (reduce u+ (map second chans))])))))

(defn lin-lin
  "Map in from [srclo srchi] to [dstlo dsthi] (built from * and +)."
  [in srclo srchi dstlo dsthi]
  (let [scale (u-div (u- dsthi dstlo) (u- srchi srclo))]
    (u+ (u* (u- in srclo) scale) dstlo)))

;; --- envelopes -------------------------------------------------------
(def ^:private shapes {:step 0 :lin 1 :linear 1 :exp 2 :exponential 2 :sin 3 :sine 3
                       :welch 4 :sqr 6 :squared 6 :cub 7 :cubed 7 :hold 8})

(defn- shape+curve [c]
  (cond (number? c) [5 c]
        (keyword? c) [(or (shapes c) (throw (ex-info (str "unknown envelope curve " c) {}))) 0]
        :else [5 c]))

(defn envelope
  "General envelope: (envelope [0 1 0] [0.1 0.5] :lin) curves can be one value or one per segment."
  ([levels durs] (envelope levels durs :lin))
  ([levels durs curves] (envelope levels durs curves -99 -99))
  ([levels durs curves release-node] (envelope levels durs curves release-node -99))
  ([levels durs curves release-node loop-node]
   (let [n (count durs)
         curves (if (sequential? curves) curves (repeat n curves))]
     (when-not (= (count levels) (inc n))
       (throw (ex-info "envelope: need one more level than durations" {})))
     {:ovt/type :env
      :data (vec (concat [(first levels) n (or release-node -99) (or loop-node -99)]
                         (mapcat (fn [l d c] (let [[s cv] (shape+curve c)] [l d s cv]))
                                 (rest levels) durs (cycle curves))))})))

(defn perc
  "(perc attack release level curve) defaults 0.01 1 1 -4"
  ([] (perc 0.01 1)) ([a r] (perc a r 1 -4)) ([a r l] (perc a r l -4))
  ([a r l c] (envelope [0 l 0] [a r] c)))

(defn adsr
  "(adsr attack decay sustain release level curve) - sustains until gate goes to 0"
  ([] (adsr 0.01 0.3 1 1)) ([a d s r] (adsr a d s r 1 -4)) ([a d s r l] (adsr a d s r l -4))
  ([a d s r l c] (envelope [0 l (u* l s) 0] [a d r] c 2)))

(defn asr
  "(asr attack sustain-level release curve) - holds until gate goes to 0"
  ([] (asr 0.01 1 1)) ([a s r] (asr a s r -4))
  ([a s r c] (envelope [0 s 0] [a r] c 1)))

(defn lin
  "(lin attack sustain release level curve) - fixed-length trapezoid"
  ([] (lin 0.01 1 1)) ([a s r] (lin a s r 1 :lin)) ([a s r l] (lin a s r l :lin))
  ([a s r l c] (envelope [0 l l 0] [a s r] c)))
(def lin-env lin)

(defn triangle ([] (triangle 1 1)) ([d] (triangle d 1))
  ([d l] (envelope [0 l 0] [(u-div d 2) (u-div d 2)] :lin)))

;; --- known gaps: give a clear error instead of "unable to resolve" ---
(defn- unsupported [nm why]
  (fn [& _] (throw (ex-info (str nm " is not available in SuperSonic: " why) {}))))
(def mouse-x (unsupported "mouse-x" "no window access in an AudioWorklet; send the value to a control bus instead"))
(def mouse-y (unsupported "mouse-y" "no window access in an AudioWorklet; send the value to a control bus instead"))
(def mouse-button (unsupported "mouse-button" "no window access in an AudioWorklet"))
(def key-state (unsupported "key-state" "no window access in an AudioWorklet"))
(def disk-in (unsupported "disk-in" "the engine has no files; load the sample into a buffer and use play-buf"))
(def disk-out (unsupported "disk-out" "the engine has no files"))
(def v-disk-in (unsupported "v-disk-in" "the engine has no files; use play-buf"))
(def beat-track (unsupported "beat-track" "not compiled into SuperSonic"))
(def onsets (unsupported "onsets" "not compiled into SuperSonic"))
(def mfcc (unsupported "mfcc" "not compiled into SuperSonic"))
(def key-track (unsupported "key-track" "not compiled into SuperSonic"))
(def loudness (unsupported "loudness" "not compiled into SuperSonic"))

(defn ugens
  "Names of the ugens this surface knows (add :kr / :ar / :ir suffix for other rates)."
  []
  (vec (keys @ugen-registry)))

(defn ugen-doc
  "(ugen-doc 'lpf) => args, defaults and rates"
  [nm]
  (if-let [s (get @ugen-registry (str nm))]
    {:sc (:sc s) :rates (:rates s) :args (mapv (fn [[k d]] (if (some? d) [k d] [k :required])) (:args s))}
    (throw (ex-info (str "unknown ugen " nm) {}))))

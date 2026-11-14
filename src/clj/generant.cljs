(ns generant)

;; Live bridge into Generant (desktop workstation) over its WS remote.
;; Connect first: (generant/connect). Then the studio snapshot powers
;; (generant/devices) and the editor's autocomplete of active synths.

(defn- g [] js/ovt.generant)

(defn connect [] (.connect (g)))
(defn connected? [] (= "connected" (.status (g))))
(defn refresh [] (.refresh (g)))
(defn state [] (js->clj (.snapshot (g)) :keywordize-keys true))
(defn devices [] (mapv :name (:devices (state))))
(defn banks [] (:banks (state)))
(defn patterns [] (mapv :name (:patterns (state))))

(defn play [] (.command (g) "/generant/v1/transport/play" (clj->js [])))
(defn stop [] (.command (g) "/generant/v1/transport/stop" (clj->js [])))
(defn tempo [bpm] (.command (g) "/generant/v1/transport/tempo" (clj->js [bpm])))

(defn pattern [p] (.command (g) "/generant/v1/pattern/queue" (clj->js [(name p)])))

;; Fire one note at a live device (id or name), MIDI pitch, velocity 0-1.
(defn note
  ([device pitch] (note device pitch 0.8))
  ([device pitch vel] (.command (g) "/generant/v1/device/note" (clj->js [(name device) pitch vel]))))

;; Bind a device to a bank pattern live: (generant/lane "Bass Lane" "i-dotted" 3)
(defn lane
  ([device pat] (lane device pat 0))
  ([device pat transpose] (.command (g) "/generant/v1/bank/lane" (clj->js [(name device) (name pat) transpose]))))

;; A device as a callable player — usable as a pbind :instrument (it accepts
;; the event params map) or fired directly.
;; (def bass (generant/device "Bass Lane"))
;; (bass 33)                      fire MIDI 33
;; (bass 33 0.5)                  with velocity
;; (bass :i-dotted)               swap its bank lane live (pattern id or name)
;; (bass :pattern "i-dotted" 3)   ...with transpose
;; (bass :param "decay" 2)        set a rack param
;; (pbind :instrument bass :note (pseq [33 36] :inf) :dur 0.5 :amp 0.4)
(defn device [n]
  (let [p (.player (g) (name n))
        dev-id (.-id (.-device p))
        fire (fn [ps]
               (let [xs (let [x (:note ps)] (if (sequential? x) x [x]))
                     vel (min 1.0 (or (:amp ps) 0.8))]
                 (doseq [x xs]
                   (.command (g) "/generant/v1/device/note" (clj->js [dev-id x vel])))))]
    (fn f
      ([a] (cond
             (map? a) (fire a)
             (keyword? a) (.pattern p (name a) 0)
             :else (.command (g) "/generant/v1/device/note" (clj->js [dev-id a 0.8]))))
      ([a b] (cond
               (number? a) (.command (g) "/generant/v1/device/note" (clj->js [dev-id a b]))
               (= a :pattern) (.pattern p (name b) 0)
               (keyword? a) (.pattern p (name a) b)
               :else (throw (ex-info "generant device player: pass a pitch, or :pattern-name [transpose]" {}))))
      ([a b c] (case a
                 :pattern (.pattern p (name b) c)
                 :param (.param p (name b) c)
                 (throw (ex-info "generant device player takes :pattern or :param as first keyword arg" {})))))))

(defn help []
  (println "generant: (connect) (refresh) (state) (devices) (patterns) (banks)")
  (println "  (play) (stop) (tempo 122) (pattern \"Pattern 02\")")
  (println "  (note \"Bass Lane\" 33) (lane \"Bass Lane\" \"i-dotted\" 3)")
  (println "  (def bass (device \"Bass Lane\")) then (bass 33) / (bass :i-dotted)")
  (println "  / (bass :pattern \"i-root\" 3) / (bass :param \"decay\" 2)"))

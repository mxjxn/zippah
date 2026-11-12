;; Compiles one tiny synth per ugen and rate the surface exposes.
;; Used by `npm test` (compile only) and the headless Chrome check
;; (which also loads each one into the real engine to catch /fail).
(defn ugen-test-defs []
  (vec
   (for [[nm spec] @ugen-registry
         rate (:rates spec)]
     (let [sname (str "t-" nm "-" (name rate))
           sdef (compile-synth
                 sname [] []
                 (fn []
                   (let [req (keep (fn [[k d]] (when (nil? d) k)) (:args spec))
                         args (mapcat (fn [k] [k (case k
                                                   :envelope (perc)
                                                   :channels (sin-osc 440)
                                                   :array [(sin-osc 440) (saw 220)]
                                                   :which 0
                                                   (white-noise))])
                                      req)
                         r (build-ugen spec rate args)]
                     (if (and (ugen? r) (:no-output r))
                       r
                       (u* 0 (mix (flatten [r]))))))
                 {})]
       (assoc sdef :ugen nm :urate rate)))))

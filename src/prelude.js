// The Clojure prelude, in load order. Vite inlines the files as strings.
import core from "./clj/core.cljs?raw";
import ugens from "./clj/ugens.cljs?raw";
import synth from "./clj/synth.cljs?raw";
import time from "./clj/time.cljs?raw";
import pattern from "./clj/pattern.cljs?raw";
import generant from "./clj/generant.cljs?raw";

export const PRELUDE = [
  ["core", core],
  ["ugens", ugens],
  ["synth", synth],
  ["time", time],
  ["pattern", pattern],
  ["generant", generant],
];

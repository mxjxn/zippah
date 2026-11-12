// Clojure evaluation via Scittle (SCI compiled for the browser).
// Scittle is loaded as a classic <script> (public/vendor/scittle.js) and
// exposes globalThis.scittle.core.eval_string.

export function createRepl({ scittle, prelude, bridge }) {
  globalThis.ovt = bridge; // the prelude calls js/ovt
  const evalString = scittle.core.eval_string;
  // prelude: [[name, source], ...] or one string
  for (const [name, src] of typeof prelude === "string" ? [["prelude", prelude]] : prelude) {
    try {
      evalString(src);
    } catch (e) {
      throw new Error(`prelude ${name} failed: ${e?.message ?? e}`);
    }
  }
  const prStr = evalString("user/__pr");
  const errData = evalString("user/__err-data");

  const show = (v) => {
    try {
      return prStr(v);
    } catch {
      return String(v);
    }
  };

  // Returns { ok, value, promise? }. Never throws.
  function evaluate(code) {
    try {
      const v = evalString(code);
      if (v && typeof v.then === "function") {
        return {
          ok: true,
          value: "#<Promise>",
          promise: v.then(
            (r) => ({ ok: true, value: show(r) }),
            (e) => ({ ok: false, value: e?.message ?? String(e) })
          ),
        };
      }
      return { ok: true, value: show(v) };
    } catch (e) {
      let where = "";
      try {
        where = errData(e) ?? "";
      } catch {}
      return { ok: false, value: (e?.message ?? String(e)) + (where ? ` ${where}` : "") };
    }
  }

  return { evaluate };
}

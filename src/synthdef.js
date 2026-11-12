// SuperCollider SynthDef file format, version 2 ("SCgf"), encoder + decoder.
// Spec: https://doc.sccode.org/Reference/Synth-Definition-File-Format.html
//
// Graph shape the encoder takes (built by the Clojure prelude):
// {
//   name: "bass",
//   params: [{name: "freq", default: 440}, ...],   // one kr Control ugen
//   ugens: [ {id, name: "SinOsc", rate: 0|1|2|3, special: 0, numOutputs: 1,
//             inputs: [ {constant: 440} | {param: "freq"} | {ugen: id, output: 0} ]}, ... ]
// }
// ugens must already be in topological order (inputs before consumers).

export const RATES = { ir: 0, kr: 1, ar: 2, dr: 3 };

class Writer {
  constructor() { this.bytes = []; }
  i8(v) { this.bytes.push(v & 0xff); }
  i16(v) { this.bytes.push((v >> 8) & 0xff, v & 0xff); }
  i32(v) { this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); }
  f32(v) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v, false);
    for (let i = 0; i < 4; i++) this.bytes.push(dv.getUint8(i));
  }
  pstr(s) {
    const enc = new TextEncoder().encode(s);
    if (enc.length > 255) throw new Error(`name too long: ${s}`);
    this.i8(enc.length);
    for (const b of enc) this.bytes.push(b);
  }
  out() { return new Uint8Array(this.bytes); }
}

export function encodeSynthDef(graph) {
  const { name, params = [], ugens } = graph;
  if (!name) throw new Error("synthdef needs a name");
  if (!ugens?.length) throw new Error(`synthdef ${name} has no ugens`);

  // Constants table (dedup by value, -0 kept distinct is irrelevant here).
  const constants = [];
  const constIndex = new Map();
  const constantOf = (v) => {
    if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`bad constant ${v} in ${name}`);
    const k = Object.is(v, -0) ? "-0" : String(v);
    if (!constIndex.has(k)) { constIndex.set(k, constants.length); constants.push(v); }
    return constIndex.get(k);
  };

  // Final ugen list: a Control ugen first if there are params.
  const list = [];
  const indexOf = new Map(); // id -> position
  const paramIndex = new Map(params.map((p, i) => [p.name, i]));
  if (params.length) {
    list.push({ name: "Control", rate: RATES.kr, special: 0, numOutputs: params.length, inputs: [], outputRate: RATES.kr });
  }
  for (const u of ugens) {
    if (indexOf.has(u.id)) throw new Error(`duplicate ugen id ${u.id}`);
    indexOf.set(u.id, list.length);
    list.push(u);
  }

  const resolve = (inp, owner) => {
    if ("constant" in inp) return [-1, constantOf(inp.constant)];
    if ("param" in inp) {
      if (!paramIndex.has(inp.param)) throw new Error(`unknown param ${inp.param}`);
      return [0, paramIndex.get(inp.param)];
    }
    if ("ugen" in inp) {
      const at = indexOf.get(inp.ugen);
      if (at === undefined) throw new Error(`${owner.name} reads a ugen that is not in the graph`);
      if (at >= indexOf.get(owner.id)) throw new Error(`${owner.name} input is not topologically before it`);
      return [at, inp.output ?? 0];
    }
    throw new Error(`bad input ${JSON.stringify(inp)}`);
  };
  // Collect constants in a stable order before writing.
  const resolved = list.map((u) => (u.name === "Control" && !u.id ? [] : u.inputs.map((inp) => resolve(inp, u))));

  const w = new Writer();
  w.i32(0x53436766); // 'SCgf'
  w.i32(2);
  w.i16(1);
  w.pstr(name);
  w.i32(constants.length);
  constants.forEach((c) => w.f32(c));
  w.i32(params.length);
  params.forEach((p) => w.f32(p.default ?? 0));
  w.i32(params.length);
  params.forEach((p, i) => { w.pstr(p.name); w.i32(i); });
  w.i32(list.length);
  list.forEach((u, i) => {
    w.pstr(u.name);
    w.i8(u.rate);
    w.i32(resolved[i].length);
    w.i32(u.numOutputs);
    w.i16(u.special ?? 0);
    resolved[i].forEach(([a, b]) => { w.i32(a); w.i32(b); });
    for (let o = 0; o < u.numOutputs; o++) w.i8(u.outputRate ?? u.rate);
  });
  w.i16(0); // variants
  return w.out();
}

export function decodeSynthDefs(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const i8 = () => dv.getInt8(p++);
  const u8 = () => dv.getUint8(p++);
  const i16 = () => { const v = dv.getInt16(p); p += 2; return v; };
  const i32 = () => { const v = dv.getInt32(p); p += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(p); p += 4; return v; };
  const pstr = () => { const n = u8(); const s = new TextDecoder().decode(bytes.subarray(p, p + n)); p += n; return s; };
  if (i32() !== 0x53436766) throw new Error("not a SCgf file");
  const version = i32();
  if (version !== 1 && version !== 2) throw new Error(`only versions 1 and 2 decoded (got ${version})`);
  const cnt = version === 1 ? i16 : i32; // v1 uses int16 counts/indices
  const defs = [];
  for (let d = 0, n = i16(); d < n; d++) {
    const name = pstr();
    const constants = Array.from({ length: cnt() }, f32);
    const params = Array.from({ length: cnt() }, f32);
    const paramNames = Array.from({ length: cnt() }, () => ({ name: pstr(), index: cnt() }));
    const ugens = Array.from({ length: cnt() }, () => {
      const name = pstr(); const rate = i8(); const ni = cnt(); const no = cnt(); const special = i16();
      const inputs = Array.from({ length: ni }, () => [cnt(), cnt()]);
      const outputs = Array.from({ length: no }, i8);
      return { name, rate, special, inputs, outputs };
    });
    const variants = Array.from({ length: i16() }, () => ({ name: pstr(), values: params.map(f32) }));
    defs.push({ name, constants, params, paramNames, ugens, variants });
  }
  if (p !== bytes.byteLength) throw new Error(`trailing bytes: ${bytes.byteLength - p}`);
  return Object.assign(defs, { version });
}

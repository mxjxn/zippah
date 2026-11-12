// Copies the run-time assets SuperSonic loads by URL (workers, AudioWorklet,
// WASM engine, synthdefs) and the Scittle (SCI) browser build into public/,
// so Vite serves them as plain static files in dev and in build output.
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (p) => join(root, "node_modules", p);
const pub = (p) => join(root, "public", p);

const copies = [
  [nm("supersonic-scsynth/dist/workers"), pub("supersonic/workers")],
  [nm("supersonic-scsynth-core/wasm"), pub("supersonic-core/wasm")],
  [nm("supersonic-scsynth-core/workers"), pub("supersonic-core/workers")],
  [nm("supersonic-scsynth-synthdefs/synthdefs"), pub("supersonic-synthdefs")],
  [nm("supersonic-scsynth-samples/samples"), pub("supersonic-samples")],
  [nm("scittle/dist/scittle.js"), pub("vendor/scittle.js")],
];

for (const [from, to] of copies) {
  if (!existsSync(from)) throw new Error(`missing ${from} - run npm install`);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`copied ${from.replace(root + "/", "")} -> ${to.replace(root + "/", "")}`);
}

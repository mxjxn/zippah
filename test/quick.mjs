import { makeWorld } from "./harness.mjs";
const w = await makeWorld().ready;
for (const c of process.argv.slice(2)) { const r = w.ev(c); console.log(c, "=>", r.ok, r.value); if (r.promise) console.log(await r.promise); }
await w.flush(); await w.flush();
console.log(JSON.stringify(w.sent.slice(-4), (k,v)=> k==="raw"?undefined:v));
console.log(w.logs.slice(-5));

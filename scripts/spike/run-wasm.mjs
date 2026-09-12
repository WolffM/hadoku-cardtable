// Wave 1, lane B: load a TeaVM WASM GC module under Node and call its entry point.
//
// Usage: node scripts/spike/run-wasm.mjs <dir-containing-spike.wasm> [args...]
//
// Requires a Node with WasmGC enabled (v22+; verified on v24.18.0).
// Prints cold-start timings so the numbers in docs/spikes/teavm-go-no-go.md are
// reproducible rather than asserted.

import { resolve } from "node:path";
import { statSync } from "node:fs";

const dir = resolve(process.argv[2] ?? ".");
const wasmPath = resolve(dir, "spike.wasm");
const runtimePath = resolve(dir, "classes.wasm-runtime.js");
const args = process.argv.slice(3);

const size = statSync(wasmPath).size;
console.error(`[runner] ${wasmPath} (${size} bytes)`);

const t0 = performance.now();
const { load } = await import(runtimePath);
const tRuntime = performance.now();

const teavm = await load(wasmPath, { nodejs: true });
const tInstantiate = performance.now();

let status = 0;
try {
  teavm.exports.main(args);
} catch (e) {
  status = 1;
  console.error("[runner] entry point threw:");
  console.error(e);
}
const tRun = performance.now();

console.error(`[runner] runtime import : ${(tRuntime - t0).toFixed(1)} ms`);
console.error(`[runner] compile+instantiate: ${(tInstantiate - tRuntime).toFixed(1)} ms`);
console.error(`[runner] main() returned in : ${(tRun - tInstantiate).toFixed(1)} ms`);
console.error(`[runner] cold start total: ${(tRun - t0).toFixed(1)} ms`);

// main() returning does NOT mean the program finished. TeaVM compiles Java
// threads to coroutines, so a Java thread that blocks (Object.wait, sleep,
// join) suspends its fiber and hands control back to the host; the rest of the
// program runs later off the event loop. process.exit() here would kill it
// mid-suspend, so set an exit code and let Node drain instead.
process.exitCode = status;

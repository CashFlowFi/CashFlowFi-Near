// Index tx hashes from ../evidence/**/*.json by pool and order, for the "Activity & receipts" drawer.
// Reads evidence only; writes src/data/receipts.json.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const evidence = join(repo, "evidence");
const out = join(here, "..", "src", "data", "receipts.json");

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : f.endsWith(".json") ? [p] : [];
  });

const index = { pools: {}, orders: {} };
if (existsSync(evidence)) {
  for (const file of walk(evidence).sort()) {
    let d;
    try { d = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    if (!d || typeof d !== "object" || !Array.isArray(d.steps)) continue;
    const steps = d.steps.filter((s) => typeof s?.tx === "string" && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(s.tx))
      .map((s) => ({ step: String(s.step ?? ""), tx: s.tx }));
    if (!steps.length) continue;
    const entry = { file: relative(repo, file), scenario: String(d.scenario ?? ""), finished_at: d.finished_at ?? null, steps };
    if (Number.isInteger(d.pool_id)) (index.pools[d.pool_id] ??= []).push(entry);
    else if (Number.isInteger(d.order_id)) (index.orders[d.order_id] ??= []).push(entry);
  }
}
writeFileSync(out, JSON.stringify(index, null, 1) + "\n");
console.log(`receipts: ${Object.keys(index.pools).length} pools, ${Object.keys(index.orders).length} orders`);

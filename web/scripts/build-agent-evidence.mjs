// Collect tier changes and TEE-written reminders from ../evidence for the /agents page.
// Reads evidence only; writes src/data/agents.json.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toReminder, toTierChange } from "../src/lib/agents.ts";
import { slimPrivacy } from "../src/lib/tee.ts";

const here = dirname(fileURLToPath(import.meta.url));
const evidence = join(here, "..", "..", "evidence");
const out = join(here, "..", "src", "data", "agents.json");

function read(sub, map) {
  const dir = join(evidence, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().flatMap((f) => {
    try {
      const v = map(JSON.parse(readFileSync(join(dir, f), "utf8")), `evidence/${sub}/${f}`);
      return v ? [v] : [];
    } catch { return []; }
  });
}

const tiers = read("tiers", toTierChange).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
const reminders = read("collections", toReminder).sort((a, b) => String(b.reminded_at).localeCompare(String(a.reminded_at)));
// Per-order TEE checks for verdicts (the API re-verifies the signature; these are the recorded check results).
const tee = {};
for (const v of read("attestations", (d) => (Number.isInteger(d.order_id) && d.tee?.privacy ? { id: d.order_id, p: slimPrivacy(d.tee.privacy) } : null))) {
  if (v.p) tee[v.id] = v.p;
}
writeFileSync(out, JSON.stringify({ tiers, reminders, tee }, null, 1) + "\n");
console.log(`agents: ${tiers.length} tier changes, ${reminders.length} reminders, ${Object.keys(tee).length} TEE check records`);

// Copy ../evidence/**/*.json into public/evidence so the in-app proof viewer can load any record on demand.
// Read-only on evidence/; public/evidence is a build artifact (gitignored).
import { cpSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "evidence");
const dst = join(here, "..", "public", "evidence");
rmSync(dst, { recursive: true, force: true });
if (existsSync(src)) {
  cpSync(src, dst, { recursive: true, filter: (p) => statSync(p).isDirectory() || p.endsWith(".json") });
}
const count = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).filter((f) => String(f).endsWith(".json")).length : 0);
console.log(`evidence: ${count(dst)} files copied to public/evidence`);

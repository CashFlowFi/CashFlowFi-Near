import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { GUIDES, guideFor } from "../src/lib/guides.ts";

const route = (href: string) => {
  const p = href.split("?")[0].replace(/^\//, "");
  const dyn = p.replace(/^(pools|invoices)\/\d+$/, "$1/[id]");
  return new URL(`../src/app/${dyn ? dyn + "/" : ""}page.tsx`, import.meta.url);
};

test("every guide step links to a page that exists in the app", () => {
  for (const g of GUIDES) for (const s of g.steps) assert.ok(existsSync(route(s.cta.href)), `${g.key}: ${s.cta.href}`);
});

test("four roles, 3 to 5 steps each, unknown role is null", () => {
  assert.deepEqual(GUIDES.map((g) => g.key), ["merchant", "customer", "investor", "visitor"]);
  for (const g of GUIDES) assert.ok(g.steps.length >= 3 && g.steps.length <= 5, g.key);
  assert.equal(guideFor("admin"), null);
});

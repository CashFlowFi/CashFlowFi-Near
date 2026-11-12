// Evidence recorder for the testnet scripts: every step's tx hash and every exact-value check
// goes into one JSON file under evidence/, written even when a step fails.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, dep, explorer } from './near.mjs';

export function createRun(scenario, file) {
  const run = { scenario, network: 'testnet', contract: dep.contract, started_at: new Date().toISOString(), steps: [], checks: [] };

  function record(step, tx, extra = {}) {
    run.steps.push({ step, tx, explorer: tx?.startsWith('0x') ? `https://sepolia.arbiscan.io/tx/${tx}` : tx ? explorer(tx) : null, ...extra });
    console.log(`✓ ${step}${tx ? `  ${tx}` : ''}`);
  }

  function check(label, got, want) {
    const ok = String(got) === String(want);
    run.checks.push({ label, got: String(got), want: String(want), ok });
    console.log(`${ok ? '  ok ' : '  FAIL'} ${label}: ${got}${ok ? '' : ` (want ${want})`}`);
    if (!ok) throw new Error(`check failed: ${label}`);
  }

  /** Runs `body(run)`, then writes the evidence file with ok=true/false. Sets the exit code on failure. */
  async function execute(body) {
    try {
      await body(run);
      run.ok = true;
    } catch (e) {
      run.ok = false;
      run.error = String(e.message || e);
      console.error(`✗ ${run.error}`);
      process.exitCode = 1;
    } finally {
      run.finished_at = new Date().toISOString();
      mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
      writeFileSync(path.join(ROOT, file), `${JSON.stringify(run, null, 2)}\n`);
      console.log(`${file} written (ok=${run.ok})`);
    }
    return run;
  }

  return { run, record, check, execute };
}

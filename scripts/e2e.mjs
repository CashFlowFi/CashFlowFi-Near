// End-to-end run on testnet against the deployed contracts, with every party involved: merchant,
// customer, two investors, a secondary buyer, the underwriter and collections agents, the forwarder,
// the relayer, the Sputnik DAO council and an outside attacker. Each scenario is its own script; this
// runs them in order and judges each one from the evidence file it writes.
//   npm run e2e            (~15 minutes; the default scenario waits out the 5-minute grace period)
// Writes evidence/e2e-run.json.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT, dep, provider, view } from './lib/near.mjs';
import { createRun } from './lib/run.mjs';

const readEvidence = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
const allBlocked = (r) => r.results.every((x) => x.result === 'blocked');

/** Scenario = script to run + the evidence it must produce + how to judge that evidence. */
const SCENARIOS = [
  { name: 'happy path, customer pays on NEAR', cmd: ['scripts/demo.mjs'], evidence: 'evidence/demo-run.json', pass: (r) => r.ok },
  { name: 'happy path, customer pays from Arbitrum via Tidepool + forwarder', cmd: ['scripts/demo.mjs'], env: { DEMO_PAY: 'tidepool', DEMO_USDC: '2' },
    evidence: 'evidence/demo-run-tidepool.json', pass: (r) => r.ok },
  { name: 'position NFTs sold mid-payout', cmd: ['scripts/nft-transfer-demo.mjs'], evidence: 'evidence/nft-transfer-run.json', pass: (r) => r.ok },
  { name: 'gasless calls through the NEP-366 relayer', cmd: ['scripts/relay-demo.mjs'], evidence: 'evidence/relayer-run.json',
    pass: (r) => r.steps?.length >= 2 && r.rejected?.length >= 2 },
  { name: 'outside attacker against the contract guards', cmd: ['scripts/attacks/onchain.mjs'], evidence: 'evidence/attacks/onchain.json', pass: allBlocked },
  { name: 'private pool matching with verified TEE', cmd: ['scripts/match.mjs', 'Low-risk, short-dated, senior only', '--filters', '{"tranche":"Senior","max_usdc":5}', '--save'],
    evidence: 'evidence/privacy/match-run.json', pass: (r) => r.response?.privacy?.verified_private === true },
  { name: 'underwriter verdict from a verified TEE, re-proved offline', cmd: ['scripts/tee-underwrite.mjs'], evidence: 'evidence/tee-underwrite-run.json', pass: (r) => r.ok },
  { name: 'default, TEE-written reminder, collections agent, Sputnik DAO cover', cmd: ['scripts/insurance-demo.mjs'], evidence: 'evidence/insurance-run.json', pass: (r) => r.ok },
];

/** The deployment must be the one recorded in deployments/testnet.json, running this repo's code. */
async function checkDeployment(check) {
  const cfg = await view(dep.contract, 'get_config');
  check('contract agent', cfg.agent_id, dep.agent);
  check('contract DAO', cfg.dao_id, dep.dao);
  check('contract token', cfg.token_id, dep.token);
  check('contract not paused', cfg.paused, false);
  check('on-chain code hash', (await provider.viewAccount({ accountId: dep.contract })).code_hash, dep.code_hash);
  check('DAO is Sputnik', await view(dep.dao, 'version'), '2.3.1');
}

/** Runs one scenario; passes only if it wrote fresh evidence that its judge accepts. */
function runScenario(s, startedMs) {
  try {
    execFileSync(process.execPath, ['--env-file-if-exists=.env', ...s.cmd], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...s.env } });
  } catch { /* judged from the evidence below */ }
  const file = path.join(ROOT, s.evidence);
  const fresh = existsSync(file) && statSync(file).mtimeMs >= startedMs;
  return { scenario: s.name, evidence: s.evidence, fresh, pass: fresh && Boolean(s.pass(readEvidence(s.evidence))) };
}

const { check, execute } = createRun('end-to-end', 'evidence/e2e-run.json');
await execute(async (run) => {
  await checkDeployment(check);
  run.scenarios = [];
  for (const s of SCENARIOS) {
    console.log(`\n=== ${s.name} ===`);
    const result = runScenario(s, Date.now());
    run.scenarios.push(result);
    console.log(`=== ${result.pass ? 'PASS' : 'FAIL'}: ${s.name}`);
  }
  const failed = run.scenarios.filter((r) => !r.pass).map((r) => r.scenario);
  if (failed.length) throw new Error(`failed: ${failed.join('; ')}`);
});

// Gasless NEP-366 run on testnet: the relayer (relayer/server.mjs wiring) runs in-process on a local port; the
// merchant and the customer only sign SignedDelegates with relayer/client.mjs. The relayer submits and pays gas.
// Checks on chain: tx signer = relayer, contract receipt predecessor = user, user's NEAR balance unchanged.
// Also sends two disallowed delegates and records the relayer's error codes. Keys are never printed.
// Writes evidence/relayer-run.json.   RELAYER_ACCOUNT defaults to the deployment owner.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { KeyPairSigner, actions } from 'near-api-js';
import { ROOT, RPC, dep, explorer, provider } from './lib/near.mjs';
import { createRelayHandler, createRelayer } from '../relayer/relay.mjs';
import { createChain, loadRelayerKey } from '../relayer/server.mjs';
import { functionCall, signDelegate, submitToRelayer } from '../relayer/client.mjs';

const relayerId = process.env.RELAYER_ACCOUNT || dep.owner;
const keyOf = (id) => JSON.parse(readFileSync(path.join(homedir(), '.near-credentials/testnet', `${id}.json`), 'utf8')).private_key;
const balance = async (id) => BigInt((await provider.viewAccount({ accountId: id })).amount);

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result;
}

/** Sign a delegate as `senderId` with the real chain nonce and a 100-block TTL. */
async function delegate(senderId, acts) {
  const signer = KeyPairSigner.fromSecretKey(keyOf(senderId));
  const key = await provider.viewAccessKey({ accountId: senderId, publicKey: await signer.getPublicKey(), finalityQuery: { finality: 'final' } });
  return signDelegate({ signer, senderId, receiverId: dep.contract, actions: acts, nonce: BigInt(key.nonce) + 1n, maxBlockHeight: BigInt(key.block_height) + 100n });
}

/** Relay one call and verify who signed, who called the contract, and that the user paid nothing. */
async function gasless(url, step, senderId, method, args) {
  const before = await balance(senderId);
  const { encoded } = await delegate(senderId, [functionCall(method, args)]);
  const out = await submitToRelayer(url, encoded);
  if (out.status !== 'success') throw new Error(`${step}: ${JSON.stringify(out)}`);
  const tx = await rpc('EXPERIMENTAL_tx_status', { tx_hash: out.txHash, sender_account_id: relayerId, wait_until: 'FINAL' });
  const inner = tx.receipts.find((r) => r.receiver_id === dep.contract && r.receipt.Action?.actions.some((a) => a.FunctionCall?.method_name === method));
  const outcome = tx.receipts_outcome.find((o) => o.id === inner?.receipt_id);
  const after = await balance(senderId);
  const checks = {
    tx_signer_is_relayer: tx.transaction.signer_id === relayerId,
    receipt_predecessor_is_user: inner?.predecessor_id === senderId,
    user_balance_unchanged: before === after,
  };
  console.log(`✓ ${step}  ${out.txHash}  ${JSON.stringify(checks)}`);
  if (!Object.values(checks).every(Boolean)) throw new Error(`${step}: check failed`);
  const ret = outcome?.outcome.status.SuccessValue;
  return {
    step, user: senderId, method: `${dep.contract}.${method}`, tx: out.txHash, explorer: explorer(out.txHash),
    tx_signer: tx.transaction.signer_id, receipt_predecessor: inner.predecessor_id, receipt_id: inner.receipt_id,
    user_balance_yocto: { before: before.toString(), after: after.toString() }, checks,
    value: ret ? JSON.parse(Buffer.from(ret, 'base64').toString() || 'null') : null,
  };
}

/** A delegate the relayer must refuse before touching the chain. */
async function refused(url, label, senderId, acts) {
  const { encoded } = await delegate(senderId, acts);
  try { await submitToRelayer(url, encoded); } catch (e) {
    console.log(`✓ refused ${label}: ${e.status} ${e.message}`);
    return { label, http_status: e.status, error: e.message, detail: e.detail ?? null };
  }
  throw new Error(`${label}: relayer accepted it`);
}

async function main() {
  const chain = createChain({ rpcUrl: RPC, relayerId, privateKey: loadRelayerKey(relayerId) });
  const relayer = createRelayer({ contractId: dep.contract, tokenId: dep.token, relayerId, chain, spendCapYocto: 10n ** 23n });
  const server = createServer(createRelayHandler(relayer)).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const relayer0 = await balance(relayerId);
  try {
    const due = (BigInt(Date.now()) * 1_000_000n + 30n * 86_400n * 10n ** 9n).toString();
    const create = await gasless(url, '1. merchant creates order (gasless)', dep.merchant, 'create_order',
      { amount: '1000000', currency: 'USDC', due_date: due, invoice_no: `RELAY-${Date.now()}`, customer_hash: 'sha256:relay-demo' });
    const approve = await gasless(url, '2. customer approves receipt (gasless)', dep.customer, 'approve_receipt', { id: create.value });
    const rejected = [
      await refused(url, 'Transfer action inside the delegate', dep.customer, [actions.transfer(1n)]),
      await refused(url, 'non-allowlisted method attest_receipt', dep.customer,
        [functionCall('attest_receipt', { id: create.value, verdict: 'Approve', score: 99, reason_hash: 'x' })]),
    ];
    const relayer1 = await balance(relayerId);
    const run = {
      network: 'testnet', standard: 'NEP-366', contract: dep.contract, relayer: relayerId, order_id: create.value,
      ran_at: new Date().toISOString(), steps: [create, approve], rejected,
      relayer_balance_yocto: { before: relayer0.toString(), after: relayer1.toString(), spent: (relayer0 - relayer1).toString() },
      relayer_health: relayer.health(),
    };
    writeFileSync(path.join(ROOT, 'evidence/relayer-run.json'), `${JSON.stringify(run, null, 2)}\n`);
    console.log(`relayer spent ${Number(relayer0 - relayer1) / 1e24} NEAR; wrote evidence/relayer-run.json`);
  } finally { server.close(); }
}

main().catch((e) => { console.error(e.message); process.exit(1); });

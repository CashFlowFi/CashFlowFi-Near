// Reproduce one private pool match against NEAR AI and the live testnet pools.
//   npm run match -- "<intent>" [--filters '{"tranche":"Senior","max_usdc":5}'] [--save]
// --save writes evidence/privacy/match-run.json, including the exact request/response bodies so anyone can recompute
// the hashes and recover the signer. Use it only with a demo intent: the API itself never stores an intent.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_RPC, writeJsonAtomic } from '../agent/near.mjs';
import { createMatchChat, loadPools, matchPools, parseMatchRequest } from '../agent/matcher.mjs';
import { DEFAULT_MATCH_MODEL, NEAR_AI } from '../agent/tee.mjs';
import { viewCall } from '../api/near.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, name === '--save' ? 1 : 2)[1] ?? true; };
const save = flag('--save') === true;
const filters = JSON.parse(flag('--filters') ?? '{}');
const request = parseMatchRequest({ intent: args.join(' '), filters });

const contractId = process.env.CASHFLOW_CONTRACT || JSON.parse(readFileSync(path.join(ROOT, 'deployments', 'testnet.json'), 'utf8')).contract;
const rpcUrl = process.env.NEAR_RPC || DEFAULT_RPC;
const model = process.env.MATCH_MODEL || DEFAULT_MATCH_MODEL;
if (!process.env.NEARAI_API_KEY) throw new Error('NEARAI_API_KEY missing (set it in .env)');

const verifiedChat = createMatchChat({ apiKey: process.env.NEARAI_API_KEY, model });
let transcript = null;
const chat = async (req) => { const r = await verifiedChat(req); transcript = r.transcript; return r; };

const { pools, scores } = await loadPools((method, a) => viewCall(contractId, method, a, { rpcUrl }));
const response = await matchPools({ ...request, pools, scores, nowNs: BigInt(Date.now()) * 1_000_000n, chat, model });
console.log(JSON.stringify(response, null, 2));

if (save) {
  const file = path.join(ROOT, 'evidence', 'privacy', 'match-run.json');
  await writeJsonAtomic(file, {
    ran_at: new Date().toISOString(), network: 'testnet', contract: contractId, model, request, response,
    raw: transcript && { request_body: transcript.request.toString('utf8'), response_body: transcript.response.toString('utf8') },
    recheck: {
      hashes: 'sha256(raw.request_body) and sha256(raw.response_body) equal privacy.evidence.request_sha256 / response_sha256',
      signature: 'viem recoverMessageAddress({ message: privacy.evidence.signed_text, signature: privacy.evidence.signature }) equals signing_address',
      signature_api: response.privacy.evidence?.chat_id ? `${NEAR_AI}/signature/${response.privacy.evidence.chat_id}?model=${model}&signing_algo=ecdsa` : null,
    },
  });
  console.log(`saved ${path.relative(ROOT, file)}`);
}

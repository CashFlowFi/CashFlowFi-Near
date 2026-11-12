// Gasless relayer service (NEP-366). Start: npm run relayer   (RELAYER_PORT defaults to 8788)
// The relayer key comes from RELAYER_PRIVATE_KEY or ~/.near-credentials/testnet/<RELAYER_ACCOUNT>.json.
// It is never printed or returned.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Account, JsonRpcProvider, actions } from 'near-api-js';
import { AccessKeyDoesNotExistError } from 'near-api-js/rpc-errors';
import { DEFAULT_RPC } from '../agent/run.mjs';
import { createRelayHandler, createRelayer } from './relay.mjs';

const YOCTO_PER_NEAR = 10n ** 24n;

/** "5" or "0.25" NEAR -> yocto, without floats. */
export function nearToYocto(s) {
  if (!/^[0-9]+(\.[0-9]{1,24})?$/.test(s)) throw new Error(`bad NEAR amount ${s}`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, '0'));
}

const positiveInt = (v, dflt, name) => {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
};

export function loadConfig(env = process.env) {
  const need = ['CASHFLOW_CONTRACT', 'USDC_TOKEN', 'RELAYER_ACCOUNT'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
  const rpcUrl = env.NEAR_RPC || DEFAULT_RPC;
  const testnetOnly = [env.CASHFLOW_CONTRACT, env.USDC_TOKEN, env.RELAYER_ACCOUNT].every((a) => a.endsWith('.testnet'))
    && !/mainnet/i.test(rpcUrl) && (env.NEAR_NETWORK ?? 'testnet') === 'testnet';
  if (!testnetOnly) throw new Error('testnet only: accounts must end in .testnet and NEAR_RPC must not be mainnet');
  return {
    rpcUrl, contractId: env.CASHFLOW_CONTRACT, tokenId: env.USDC_TOKEN, relayerId: env.RELAYER_ACCOUNT,
    port: positiveInt(env.RELAYER_PORT, 8788, 'RELAYER_PORT'),
    corsOrigin: env.CORS_ORIGIN || '*',
    spendCapYocto: nearToYocto(env.RELAYER_SPEND_CAP_NEAR || '5'),
    rateLimit: positiveInt(env.RELAYER_RATE_LIMIT, 10, 'RELAYER_RATE_LIMIT'),
    rateWindowMs: positiveInt(env.RELAYER_RATE_WINDOW_SEC, 600, 'RELAYER_RATE_WINDOW_SEC') * 1000,
    maxTtlBlocks: positiveInt(env.RELAYER_MAX_TTL_BLOCKS, 600, 'RELAYER_MAX_TTL_BLOCKS'),
  };
}

/** RELAYER_PRIVATE_KEY wins; otherwise the near-cli legacy keychain file. Returns the key string only. */
export function loadRelayerKey(relayerId, env = process.env, home = homedir()) {
  if (env.RELAYER_PRIVATE_KEY) return env.RELAYER_PRIVATE_KEY;
  const file = path.join(home, '.near-credentials', 'testnet', `${relayerId}.json`);
  if (!existsSync(file)) throw new Error(`no relayer key: set RELAYER_PRIVATE_KEY or create ${file}`);
  const key = JSON.parse(readFileSync(file, 'utf8')).private_key;
  if (typeof key !== 'string' || !key.startsWith('ed25519:')) throw new Error(`${file} has no ed25519 private_key`);
  return key;
}

/** Real chain wiring for createRelayer. */
export function createChain({ rpcUrl, relayerId, privateKey }) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const account = new Account(relayerId, provider, privateKey);
  return {
    async viewAccessKey(accountId, publicKey) {
      try { return await provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: 'final' } }); }
      catch (e) { if (e instanceof AccessKeyDoesNotExistError) return null; throw e; }
    },
    relay: (signedDelegate) => account.signAndSendTransaction({
      receiverId: signedDelegate.delegateAction.senderId,
      actions: [actions.signedDelegate(signedDelegate)],
      throwOnFailure: false, // report on-chain failures as { status: 'failure' } with the tx hash
    }),
  };
}

function main() {
  const root = path.resolve(import.meta.dirname, '..');
  if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  const cfg = loadConfig();
  const chain = createChain({ rpcUrl: cfg.rpcUrl, relayerId: cfg.relayerId, privateKey: loadRelayerKey(cfg.relayerId) });
  const relayer = createRelayer({ ...cfg, chain });
  createServer(createRelayHandler(relayer, { corsOrigin: cfg.corsOrigin })).listen(cfg.port, () => {
    console.log(`relayer ${cfg.relayerId} on :${cfg.port} -> ${cfg.contractId} / ${cfg.tokenId} via ${cfg.rpcUrl}, cap ${process.env.RELAYER_SPEND_CAP_NEAR || '5'} NEAR`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}

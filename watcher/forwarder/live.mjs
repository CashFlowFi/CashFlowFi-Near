// Live wiring for the forwarder: NEAR RPC + Tidepool + the forwarder key. Testnet only.

import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, actions, baseEncode } from 'near-api-js';
import { lookupTx, txStatus, viewCall } from '../../api/near.mjs';
import { resolvePrivateKey } from '../../agent/near.mjs';
import { TIDEPOOL, fetchStatus } from '../tidepool.mjs';
import { createFileStore } from './store.mjs';

const fail = (code) => { throw new Error(code); };

/** Production deps. The forwarder key comes from FORWARDER_PRIVATE_KEY or ~/.near-credentials; never printed. */
export function createLiveDeps({ contractId, forwarder, rpcUrl, evidenceDir, privateKey = null, log = console.log }) {
  if (![contractId, forwarder].every((a) => typeof a === 'string' && a.endsWith('.testnet')) || /mainnet/i.test(rpcUrl)) fail('testnet only');
  const near = { rpcUrl };
  const provider = new JsonRpcProvider({ url: rpcUrl });
  let account = null;
  const signer = () => (account ??= new Account(forwarder, provider, resolvePrivateKey(forwarder, privateKey)));
  return {
    config: { contractId, forwarder, tokenId: TIDEPOOL.destinationToken },
    store: createFileStore(evidenceDir),
    fetchStatus: (addr) => fetchStatus(addr),
    txStatus: (hash, sender) => txStatus(hash, sender, near),
    lookupTx: (hash, sender) => lookupTx(hash, sender, near),
    viewOrder: (id) => viewCall(contractId, 'get_order', { id }, near),
    ftBalance: (id) => viewCall(TIDEPOOL.destinationToken, 'ft_balance_of', { account_id: id }, near),
    signForward: async ({ amount, msg }) => signForward(signer(), provider, { contractId, amount, msg }),
    now: () => Math.floor(Date.now() / 1000),
    log,
  };
}

/** Sign once; `send` broadcasts exactly those bytes and checks the node reports the hash we claimed. */
async function signForward(account, provider, { contractId, amount, msg }) {
  const signed = await account.createSignedTransaction({ receiverId: TIDEPOOL.destinationToken,
    actions: [actions.functionCall('ft_transfer_call', { receiver_id: contractId, amount, msg }, 150_000_000_000_000n, 1n)] });
  const hash = baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
  const send = async () => {
    const res = await provider.sendTransactionUntil(signed, 'FINAL');
    const got = res?.transaction_outcome?.id ?? res?.transaction?.hash;
    if (got !== hash) fail(`FORWARD_HASH_MISMATCH: computed ${hash}, node reported ${got}`);
    return res;
  };
  return { hash, signedBase64: Buffer.from(signed.encode()).toString('base64'), send };
}

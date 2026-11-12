// Client side of the relayer: build and sign a NEP-366 SignedDelegate with the user's key, then POST it.
// No Node-only APIs, so the frontend can import it as well as scripts and tests.
//
//   const { signedDelegate } = await signDelegate({ signer: KeyPairSigner.fromSecretKey(key), senderId,
//     receiverId: CASHFLOW, actions: [functionCall('approve_receipt', { id: 7 })], nonce, maxBlockHeight });
//   await submitToRelayer(RELAYER_URL, signedDelegate);
//
// Or let near-api-js read nonce and block height for you: signDelegateFor(account, { receiverId, actions }).
import { actions, base64Encode, buildDelegateAction, encodeSignedDelegate } from 'near-api-js';

const TGAS = 1_000_000_000_000n;

/** A FunctionCall action. Defaults match docs/INTERFACE.md: 30 TGas, 0 deposit. */
export const functionCall = (methodName, args, { gas = 30n * TGAS, deposit = 0n } = {}) =>
  actions.functionCall(methodName, args, gas, deposit);

/** USDC ft_transfer_call into the cashflow contract (1 yocto, 150 TGas). msg is an object, e.g. { pay: { order_id: 7 } }. */
export const ftTransferCall = ({ contractId, amount, msg, gas = 150n * TGAS }) =>
  actions.functionCall('ft_transfer_call', { receiver_id: contractId, amount: String(amount), msg: JSON.stringify(msg) }, gas, 1n);

/** Base64 borsh SignedDelegate, the body field POST /relay expects. */
export const encodeSignedDelegateBase64 = (signedDelegate) => base64Encode(encodeSignedDelegate(signedDelegate));

/** Sign with an explicit nonce and max block height (no RPC). `signer` is a near-api-js Signer, e.g. KeyPairSigner. */
export async function signDelegate({ signer, senderId, receiverId, actions: acts, nonce, maxBlockHeight }) {
  const delegateAction = buildDelegateAction({
    senderId, receiverId, actions: acts, nonce: BigInt(nonce), maxBlockHeight: BigInt(maxBlockHeight),
    publicKey: await signer.getPublicKey(),
  });
  const { signedDelegate, delegateHash } = await signer.signDelegateAction(delegateAction);
  return { signedDelegate, delegateHash, encoded: encodeSignedDelegateBase64(signedDelegate) };
}

/** Sign using a near-api-js Account (with signer): it reads the key nonce and current block height from RPC. */
export async function signDelegateFor(account, { receiverId, actions: acts, blockHeightTtl = 200 }) {
  const { signedDelegate, delegateHash } = await account.createSignedMetaTransaction({ receiverId, actions: acts, blockHeightTtl });
  return { signedDelegate, delegateHash, encoded: encodeSignedDelegateBase64(signedDelegate) };
}

/** POST to the relayer. Resolves { txHash, status }; throws Error(code) with .status and .detail on a JSON error. */
export async function submitToRelayer(relayerUrl, signedDelegateOrEncoded, { fetchImpl = fetch } = {}) {
  const encoded = typeof signedDelegateOrEncoded === 'string' ? signedDelegateOrEncoded : encodeSignedDelegateBase64(signedDelegateOrEncoded);
  const r = await fetchImpl(new URL('/relay', relayerUrl).href, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signedDelegate: encoded }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error ?? `HTTP_${r.status}`), { status: r.status, detail: body.detail });
  return body;
}

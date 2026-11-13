// Gas-free calls (NEP-366): sign a DelegateAction with the browser's function-call key and hand it to our relayer,
// which pays the gas. Only zero-deposit calls on the cashflow contract qualify, because a function-call key
// cannot attach a deposit and is scoped to that one contract.
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators, buildDelegateAction, encodeSignedDelegate } from "@near-js/transactions";
import type { TxSpec } from "./tx.ts";

export const GASLESS_METHODS = new Set(["create_order", "approve_receipt", "create_pool", "claim"]);

/** The key MyNearWallet stores in localStorage ("functionCallKey") after sign-in with a contractId. */
export interface FunctionCallKey {
  privateKey: string;
  contractId: string;
  methods?: string[];
}

/** True when this tx can go through the relayer with this key. */
export function gaslessEligible(spec: TxSpec, key: FunctionCallKey | null, contractId: string): boolean {
  if (!key || key.contractId !== contractId || spec.receiverId !== contractId) return false;
  const allowed = key.methods && key.methods.length ? new Set(key.methods) : null;
  return spec.calls.every((c) => c.deposit === "0" && GASLESS_METHODS.has(c.method) && (!allowed || allowed.has(c.method)));
}

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** Pure: sign with an explicit nonce and max block height. Returns the base64 body field POST /relay expects. */
export async function signDelegateBase64(args: {
  privateKey: string; senderId: string; spec: TxSpec; nonce: bigint; maxBlockHeight: bigint;
}): Promise<{ encoded: string; publicKey: string }> {
  const signer = KeyPairSigner.fromSecretKey(args.privateKey as `ed25519:${string}`);
  const publicKey = await signer.getPublicKey();
  const delegateAction = buildDelegateAction({
    senderId: args.senderId,
    receiverId: args.spec.receiverId,
    actions: args.spec.calls.map((c) => actionCreators.functionCall(c.method, c.args, BigInt(c.gas), BigInt(c.deposit))),
    nonce: args.nonce,
    maxBlockHeight: args.maxBlockHeight,
    publicKey,
  });
  // @near-js/signers 2.5 returns [hash, signedDelegate].
  const [, signedDelegate] = await signer.signDelegateAction(delegateAction);
  return { encoded: toBase64(encodeSignedDelegate(signedDelegate)), publicKey: publicKey.toString() };
}

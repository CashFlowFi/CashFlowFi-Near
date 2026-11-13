// Read-only contract views over JSON-RPC. No wallet, no keys.
import { CONTRACT, RPC_URL, TOKEN } from "./config";
import type { Config, Order, Pool, Position } from "./types";

export class ChainError extends Error {}

function b64(s: string): string {
  return typeof window === "undefined" ? Buffer.from(s).toString("base64") : btoa(s);
}

export async function view<T>(method: string, args: object = {}, account = CONTRACT): Promise<T> {
  let res: Response;
  try {
    res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "cf",
        method: "query",
        params: { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: b64(JSON.stringify(args)) },
      }),
      cache: "no-store",
    });
  } catch (e) {
    throw new ChainError(`NEAR RPC unreachable (${(e as Error).message})`);
  }
  if (!res.ok) throw new ChainError(`NEAR RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new ChainError(body.error?.cause?.name ?? body.error?.message ?? "RPC error");
  if (body.result?.error) throw new ChainError(String(body.result.error));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as T;
}

export const getPool = (id: number) => view<Pool | null>("get_pool", { id });
export const getOrder = (id: number) => view<Order | null>("get_order", { id });
export const getConfig = () => view<Config>("get_config");
export const getInsurance = () => view<{ balance: string; total_paid: string; treasury: string }>("get_insurance");

export async function getAllPools(): Promise<Pool[]> {
  const out: Pool[] = [];
  for (let from = 0; ; from += 100) {
    const page = await view<Pool[]>("get_pools", { from_index: from, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
}

export interface NftToken {
  token_id: string;
  owner_id: string;
  metadata: { title?: string; media?: string; extra?: string };
}

export async function getAllTokens(): Promise<NftToken[]> {
  const out: NftToken[] = [];
  for (let from = 0; ; from += 50) {
    const page = await view<NftToken[]>("nft_tokens", { from_index: String(from), limit: 50 });
    out.push(...page);
    if (page.length < 50) return out;
  }
}

/** Positions of one pool. Token ids are "<pool_id>-<seq>". */
export async function getPoolPositions(poolId: number): Promise<Position[]> {
  const tokens = (await getAllTokens()).filter((t) => t.token_id.startsWith(`${poolId}-`));
  const positions = await Promise.all(tokens.map((t) => view<Position | null>("get_position", { token_id: t.token_id })));
  return positions.filter((p): p is Position => p !== null);
}

export const getNftsForOwner = (owner: string) =>
  view<NftToken[]>("nft_tokens_for_owner", { account_id: owner, from_index: "0", limit: 100 });

export async function getAllOrders(): Promise<Order[]> {
  const out: Order[] = [];
  for (let from = 0; ; from += 100) {
    const page = await view<Order[]>("get_orders", { from_index: from, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
}


export const getFtBalance = (accountId: string) => view<string>("ft_balance_of", { account_id: accountId }, TOKEN);
export const isRegistered = async (accountId: string) =>
  (await view<{ total: string } | null>("storage_balance_of", { account_id: accountId }, TOKEN)) !== null;
export const getOrdersByMerchant = (merchant: string) => view<Order[]>("get_orders_by_merchant", { merchant });
export const getPositionsByOwner = (owner: string) => view<Position[]>("get_positions_by_owner", { owner });
export const getWithdrawable = (accountId: string) => view<string>("get_withdrawable", { account_id: accountId });
export const getTier = (merchant: string) => view<import("./types").Tier>("get_tier", { merchant });

/** Final outcome of a tx, used after a redirect wallet returns with ?transactionHashes=. */
export async function txStatus(hash: string, sender: string): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "cf", method: "tx", params: { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" } }),
  });
  const body = await res.json();
  if (body.error) throw new ChainError(body.error?.cause?.name ?? "RPC error");
  return body.result;
}

/** Access-key nonce and the block height it was read at (for signing a delegate action). */
export async function viewAccessKey(accountId: string, publicKey: string): Promise<{ nonce: number; block_height: number }> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "cf", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) throw new ChainError(String(body.error?.cause?.name ?? body.result?.error ?? "RPC error"));
  return body.result;
}

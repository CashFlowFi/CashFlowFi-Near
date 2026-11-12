export const NETWORK = "testnet";
export const RPC_URL = process.env.NEXT_PUBLIC_NEAR_RPC ?? "https://test.rpc.fastnear.com";
export const CONTRACT = process.env.NEXT_PUBLIC_CASHFLOW_CONTRACT ?? "cashflow.cashflowfi.testnet";
export const TOKEN = process.env.NEXT_PUBLIC_TOKEN_CONTRACT ?? "usdc.tidepool-sandbox.testnet";
/** Off-chain API (verdicts, pay quote/status, matching). Optional: screens degrade to "unavailable". */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
export const EXPLORER = "https://testnet.nearblocks.io";
export const REPO_URL = "https://github.com/CashFlowFi/CashFlowFi-Near";
export const FEATURED_POOL = 22;

/** Accounts the scripts and evidence use. Labelled, never presented as the visitor's own. */
export const DEMO_ACCOUNTS: Record<string, string> = {
  "merchant.cashflowfi.testnet": "demo merchant",
  "customer.cashflowfi.testnet": "demo customer",
  "alice.cashflowfi.testnet": "demo investor",
  "bob.cashflowfi.testnet": "demo investor",
  "carol.cashflowfi.testnet": "demo investor",
  "agent.cashflowfi.testnet": "underwriter agent",
  "dao.cashflowfi.testnet": "insurance DAO",
  "payments.cashflowfi.testnet": "payment forwarder",
};

export const txUrl = (hash: string) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (id: string) => `${EXPLORER}/address/${id}`;
export const repoFileUrl = (path: string) => `${REPO_URL}/blob/main/${path}`;

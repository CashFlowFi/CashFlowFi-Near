import { formatUsdc } from "./amount.ts";
import { parseUsdcInput } from "./tx.ts";

export type AmountCheck = { amount: bigint; error: null } | { amount: null; error: string };

/** Validate a typed amount against what fits (room or still owed) and the wallet balance. */
export function checkAmount(text: string, limits: { max?: bigint; balance?: bigint | null }): AmountCheck {
  const amount = parseUsdcInput(text);
  if (amount === null) return { amount: null, error: "Enter an amount in USDC, up to 6 decimals." };
  if (amount <= BigInt(0)) return { amount: null, error: "Enter an amount above zero." };
  if (limits.max !== undefined && amount > limits.max) return { amount: null, error: `Up to ${formatUsdc(limits.max)} USDC fits here.` };
  if (limits.balance !== undefined && limits.balance !== null && amount > limits.balance)
    return { amount: null, error: `Your balance is ${formatUsdc(limits.balance)} USDC.` };
  return { amount, error: null };
}

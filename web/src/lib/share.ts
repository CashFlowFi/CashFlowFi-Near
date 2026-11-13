// Share an invoice with the buyer: message text, chat-app links and a standard EVM payment URI.
import { formatUsdc } from "./amount.ts";

export type ShareStep = "approve" | "pay";

export function invoiceShareText(o: { invoiceNo: string; amount: string; merchant: string; step: ShareStep }, url: string): string {
  const ask = o.step === "approve" ? "Please review and approve it on-chain" : "You can pay it from NEAR or from Arbitrum";
  return `Invoice ${o.invoiceNo} for ${formatUsdc(o.amount)} USDC from ${o.merchant}. ${ask}: ${url}`;
}

export const whatsappUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;
export const telegramUrl = (url: string, text: string) =>
  `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text.replace(`: ${url}`, ""))}`;

/**
 * EIP-681 ERC-20 transfer URI, scannable by EVM wallets such as MetaMask mobile:
 * ethereum:<token>@<chainId>/transfer?address=<to>&uint256=<base units>
 */
export function erc20TransferUri(token: string, chainId: number, to: string, amount: string | bigint): string {
  const hex = /^0x[0-9a-fA-F]{40}$/;
  if (!hex.test(token) || !hex.test(to)) throw new Error("Not an EVM address");
  if (!/^\d+$/.test(String(amount))) throw new Error("Amount must be base units");
  return `ethereum:${token}@${chainId}/transfer?address=${to}&uint256=${amount}`;
}

/** "Is this invoice for me?": the merchant stored sha256(lower-cased, trimmed reference) as customer_hash. */
export const isRealCustomerHash = (h: string) => /^sha256:[0-9a-f]{64}$/.test(h);
export async function customerHashOf(ref: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ref.trim().toLowerCase())));
  return "sha256:" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

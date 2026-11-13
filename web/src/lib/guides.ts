// Role guides: the few steps each kind of user takes, each pointing at the exact page for it.

export type RoleKey = "merchant" | "customer" | "investor" | "visitor";

export interface GuideStep {
  title: string;
  line: string;
  cta: { label: string; href: string };
  /** Marks the steps where the AI agents act. */
  ai?: boolean;
}

export interface Guide {
  key: RoleKey;
  label: string;
  emoji: string;
  pitch: string;
  steps: GuideStep[];
}

export const GUIDES: Guide[] = [
  {
    key: "merchant",
    label: "Merchant",
    emoji: "🏪",
    pitch: "Turn an unpaid invoice into cash today.",
    steps: [
      { title: "Create an invoice", line: "Amount, due date and your customer's email. Sign in with a NEAR testnet wallet first.", cta: { label: "Open merchant desk", href: "/merchant" } },
      { title: "Send it to your customer", line: "A QR code and WhatsApp / Telegram links appear as soon as the invoice is created.", cta: { label: "See an example", href: "/invoices/41" } },
      { title: "The AI checks it", line: "After your customer approves, the underwriter scores it in a verified TEE, usually within a minute.", cta: { label: "See AI verdicts", href: "/agents" }, ai: true },
      { title: "Open a pool, get your advance", line: "Pick approved invoices. When investors fill the pool, the advance lands in your wallet.", cta: { label: "Open merchant desk", href: "/merchant" } },
      { title: "Receive the rest", line: "When your customer pays, investors are repaid first and the remainder comes back to you.", cta: { label: "See a repaid pool", href: "/pools/22" } },
    ],
  },
  {
    key: "customer",
    label: "Customer",
    emoji: "🧾",
    pitch: "Confirm a purchase and pay from any chain.",
    steps: [
      { title: "Open the merchant's link", line: "Scan the QR or tap the link the merchant sent you.", cta: { label: "See an invoice", href: "/invoices/41" } },
      { title: "Approve it with your wallet", line: "Your signature confirms the sale on-chain. The merchant cannot approve its own invoice.", cta: { label: "Approve an invoice", href: "/invoices/41" } },
      { title: "Pay when it's due", line: "Pay on NEAR, or from Arbitrum through NEAR Intents. Any overpayment is refunded automatically.", cta: { label: "See the pay page", href: "/invoices/5" } },
    ],
  },
  {
    key: "investor",
    label: "Investor",
    emoji: "💰",
    pitch: "Fund AI-checked invoices and earn when they're paid.",
    steps: [
      { title: "Ask the AI for a pool", line: "Describe what you want in plain words. A NEAR AI model in a TEE ranks the open pools; your text is never stored.", cta: { label: "Find a tranche", href: "/portfolio" }, ai: true },
      { title: "Invest", line: "Senior is paid first. Junior earns more and takes the first loss. You get a position NFT.", cta: { label: "Browse pools", href: "/pools" } },
      { title: "Claim your payouts", line: "When the customer pays, your share is ready to claim from your portfolio.", cta: { label: "Open portfolio", href: "/portfolio" } },
      { title: "Sell or give your position", line: "Transfer the NFT and future payouts follow the new holder.", cta: { label: "Open portfolio", href: "/portfolio" } },
    ],
  },
  {
    key: "visitor",
    label: "Just looking",
    emoji: "👀",
    pitch: "See real pools, step by step, with proof.",
    steps: [
      { title: "Replay a repaid pool", line: "Every stage from invoice to payout, read live from NEAR testnet.", cta: { label: "Open pool 22", href: "/pools/22" } },
      { title: "See a default covered", line: "The customer paid part; insurance covered investors after a DAO vote.", cta: { label: "Open pool 25", href: "/pools/25" } },
      { title: "Check the AI's work", line: "Every verdict with its TEE proof, the tier change and the reminders.", cta: { label: "Open agents", href: "/agents" }, ai: true },
      { title: "Look at the insurance fund", line: "Fund balance, defaulted pools and the DAO's votes.", cta: { label: "Open insurance", href: "/insurance" } },
    ],
  },
];

export const guideFor = (key: string): Guide | null => GUIDES.find((g) => g.key === key) ?? null;

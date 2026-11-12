// Per-sender rate limit, global spend cap and replay guard. In memory, for one relayer process.
import { RelayError } from './errors.mjs';
import { TGAS } from './policy.mjs';

// Fixed cost of the outer tx + delegate receipt, counted against the spend cap on top of attached gas.
const OVERHEAD_GAS = 10n * TGAS;

export function createLimits({ rateLimit, rateWindowMs, spendCapYocto, gasPriceYocto, now }) {
  const recent = new Map(); // sender -> timestamps of accepted relays
  const seen = new Map(); // `${sender}|${pk}|${nonce}` -> expiry ms
  let spent = 0n;
  const window = (sender, t) => (recent.get(sender) ?? []).filter((x) => x > t - rateWindowMs);
  const rateLimited = () => new RelayError(429, 'RATE_LIMITED', `${rateLimit} per ${rateWindowMs / 1000}s`);

  /** Upper bound on what relaying costs us: all attached gas plus overhead at the cap price, plus every deposit. */
  const estimateCost = ({ totalGas, totalDeposit }) => (totalGas + OVERHEAD_GAS) * gasPriceYocto + totalDeposit;

  /** Early refusal before any RPC read. Not a reservation: `reserve` checks again. */
  function precheck(sender, cost) {
    const t0 = now();
    if (window(sender, t0).length >= rateLimit) throw rateLimited();
    if (spent + cost > spendCapYocto) throw new RelayError(503, 'SPEND_CAP_REACHED');
  }

  // Re-check and reserve synchronously: the caller must not await between this and the send, so concurrent
  // requests cannot both pass the rate limit, the spend cap or the replay check.
  function reserve(d, cost) {
    const t = now();
    for (const [k, exp] of seen) if (exp <= t) seen.delete(k);
    const id = `${d.senderId}|${d.publicKey}|${d.nonce}`;
    if (seen.has(id)) throw new RelayError(409, 'DUPLICATE_DELEGATE');
    const w = window(d.senderId, t);
    if (w.length >= rateLimit) throw rateLimited();
    if (spent + cost > spendCapYocto) throw new RelayError(503, 'SPEND_CAP_REACHED');
    recent.set(d.senderId, [...w, t]);
    seen.set(id, t + rateWindowMs + 60 * 60_000);
    // Reserved as an upper bound and never released: a send that errors may still have landed.
    spent += cost;
  }

  return { estimateCost, precheck, reserve, spent: () => spent };
}

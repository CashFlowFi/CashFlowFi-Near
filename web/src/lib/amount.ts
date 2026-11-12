// Token amounts are base-unit strings (U128). All math is BigInt; format only for display.

export const USDC_DECIMALS = 6;

/** Parse a base-unit string. Throws on anything that is not a non-negative integer. */
export function toBig(value: string | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!/^\d+$/.test(value)) throw new Error(`Not a base-unit amount: ${JSON.stringify(value)}`);
  return BigInt(value);
}

export function sum(...values: (string | bigint)[]): bigint {
  return values.reduce<bigint>((acc, v) => acc + toBig(v), BigInt(0));
}

/** Never negative: room left, amount still owed. */
export function remaining(target: string | bigint, done: string | bigint): bigint {
  const r = toBig(target) - toBig(done);
  return r > BigInt(0) ? r : BigInt(0);
}

/**
 * Format base units for display: thousands separators, at least 2 decimals,
 * trailing zeros beyond that trimmed, no rounding.
 * formatUsdc("4781250") === "4.78125", formatUsdc("1000000000") === "1,000.00"
 */
export function formatUsdc(value: string | bigint, decimals = USDC_DECIMALS): string {
  const v = toBig(value);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = (v / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
}

/** Whole percent of part/whole, floored. Returns null when whole is 0. */
export function percent(part: string | bigint, whole: string | bigint): number | null {
  const w = toBig(whole);
  if (w === BigInt(0)) return null;
  return Number((toBig(part) * BigInt(100)) / w);
}

/** Nanosecond timestamp string to a Date (ms precision). */
export function nsToDate(ns: string): Date {
  return new Date(Number(toBig(ns) / BigInt(1_000_000)));
}

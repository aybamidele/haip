import Decimal from 'decimal.js';

// Stripe uses two decimals for ISK/UGX charges although ISO describes zero.
const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
function exponent(currency: string) {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error('Invalid currency');
  const iso = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
  if (iso == null || iso > 2) throw new Error('Currency exceeds payment ledger precision');
  return zeroDecimal.has(code) ? 0 : 2;
}
export function stripeMinorUnits(amount: string | number, currency: string): number {
  const minor = new Decimal(amount).mul(10 ** exponent(currency));
  if (!minor.isInteger() || !Number.isSafeInteger(minor.toNumber()) || minor.isNegative()) throw new Error('Invalid Stripe amount');
  if (['ISK', 'UGX'].includes(currency.toUpperCase()) && !minor.mod(100).equals(0)) throw new Error('Currency requires whole major units');
  return minor.toNumber();
}
export function stripeMajorUnits(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error('Invalid Stripe amount');
  return new Decimal(minor).div(10 ** exponent(currency)).toFixed(2);
}

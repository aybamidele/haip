import { describe, it, expect } from 'vitest';
import { stripeMinorUnits, stripeMajorUnits } from './stripe-money';
describe('Stripe currency amounts at the ledger boundary', () => {
  it('preserves exact GBP cents and zero-decimal JPY', () => {
    expect(stripeMinorUnits('19.99', 'GBP')).toBe(1999);
    expect(stripeMajorUnits(1999, 'GBP')).toBe('19.99');
    expect(stripeMinorUnits('1999.00', 'JPY')).toBe(1999);
    expect(stripeMajorUnits(1999, 'JPY')).toBe('1999.00');
  });
  it('rejects fractional yen, fractional ISK/UGX, negative and unsafe amounts', () => {
    expect(() => stripeMinorUnits('1.01', 'JPY')).toThrow();
    expect(() => stripeMinorUnits('1.01', 'ISK')).toThrow();
    expect(() => stripeMinorUnits('1.01', 'UGX')).toThrow();
    expect(() => stripeMinorUnits(-1, 'GBP')).toThrow();
    expect(() => stripeMinorUnits('9007199254740992', 'GBP')).toThrow();
  });
  it('rejects a currency that needs more precision than HAIP stores', () => {
    expect(() => stripeMinorUnits('1.001', 'BHD')).toThrow('ledger precision');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { assertStripeAccount } from './stripe-context';

describe('Stripe application account boundary', () => {
  const config = (values: Record<string, string> = {}) => new ConfigService({ STRIPE_ACCOUNT_ID: 'acct_synthetic', STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'rk_test_synthetic', ...values });
  it('rejects missing configuration and a live key in test mode before contacting Stripe', async () => {
    const client = { accounts: { retrieve: vi.fn() } } as any;
    await expect(assertStripeAccount(client, config({ STRIPE_ACCOUNT_ID: '' }))).rejects.toMatchObject({ status: 503 });
    await expect(assertStripeAccount(client, config({ STRIPE_SECRET_KEY: 'sk_live_synthetic' }))).rejects.toMatchObject({ status: 503 });
    expect(client.accounts.retrieve).not.toHaveBeenCalled();
  });
  it('rejects another account independently of CLI or MCP authentication', async () => {
    const client = { accounts: { retrieve: vi.fn(async () => ({ id: 'acct_other' })) } } as any;
    await expect(assertStripeAccount(client, config())).rejects.toMatchObject({ status: 409 });
  });
  it('caches a verified client but verifies a newly configured account and a replacement client', async () => {
    const client = { accounts: { retrieve: vi.fn(async () => ({ id: 'acct_synthetic' })) } } as any;
    await assertStripeAccount(client, config()); await assertStripeAccount(client, config());
    expect(client.accounts.retrieve).toHaveBeenCalledTimes(1);
    await expect(assertStripeAccount(client, config({ STRIPE_ACCOUNT_ID: 'acct_other' }))).rejects.toMatchObject({ status: 409 });
    const replacement = { accounts: { retrieve: vi.fn(async () => ({ id: 'acct_other' })) } } as any;
    await expect(assertStripeAccount(replacement, config())).rejects.toMatchObject({ status: 409 });
  });
});

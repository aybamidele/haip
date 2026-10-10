import { ServiceUnavailableException, ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';

const verified = new WeakMap<object, string>();
/** Pin every application mutation to the configured account and key mode, independently of CLI/MCP login. */
export async function assertStripeAccount(stripe: Stripe, config: ConfigService): Promise<string> {
  const id = config.get<string>('STRIPE_ACCOUNT_ID');
  const mode = config.get<string>('STRIPE_MODE');
  const key = config.get<string>('STRIPE_SECRET_KEY') ?? '';
  if (!id || !/^acct_[A-Za-z0-9]+$/.test(id) || !['test', 'live'].includes(mode ?? '')
    || !key.startsWith(`sk_${mode}_`) && !key.startsWith(`rk_${mode}_`)) throw new ServiceUnavailableException('Stripe account and matching key mode must be configured');
  if (verified.get(stripe) === id) return id;
  const account = await stripe.accounts.retrieve(null);
  if (account.id !== id) throw new ConflictException('Stripe API key belongs to another account');
  verified.set(stripe, id);
  return id;
}

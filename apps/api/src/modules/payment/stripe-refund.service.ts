import { assertStripeAccount } from './stripe-context';
import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { payments, folios, depositLedgerEntries } from '@telivityhaip/database';
import Decimal from 'decimal.js';
import Stripe from 'stripe';
import { DRIZZLE } from '../../database/database.module';
import { FolioService } from '../folio/folio.service';
import { StripeEventService, type StripeEmit } from './stripe-event.service';
import { stripeMinorUnits } from './stripe-money';
import { sumRefundChildren } from './payment-ledger';

/** Pending negative children reserve refundable money without crediting the folio until success. */
@Injectable()
export class StripeRefundService {
  private readonly stripe: Stripe | null;
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly config: ConfigService,
    private readonly folioService: FolioService, private readonly events: StripeEventService) {
    const key = config.get<string>('STRIPE_SECRET_KEY');
    this.stripe = key ? new Stripe(key, { timeout: 10_000, maxNetworkRetries: 2 }) : null;
  }
  private client() { if (!this.stripe) throw new ServiceUnavailableException('Stripe refunds are not configured'); return this.stripe; }
  private async lockParent(tx: any, id: string, propertyId: string) {
    const [reference] = await tx.select().from(payments).where(and(eq(payments.id, id), eq(payments.propertyId, propertyId)));
    if (!reference || reference.originalPaymentId || reference.bookingRequestId || reference.gatewayProvider !== 'stripe') throw new NotFoundException('Stripe payment not found');
    if (reference.folioId) await tx.select().from(folios).where(and(eq(folios.id, reference.folioId), eq(folios.propertyId, propertyId))).for('update');
    const [parent] = await tx.select().from(payments).where(and(eq(payments.id, id), eq(payments.propertyId, propertyId))).for('update');
    const accountId = await assertStripeAccount(this.client(), this.config);
    if (parent.gatewayAccountId && parent.gatewayAccountId !== accountId) throw new ConflictException('Payment belongs to another Stripe account');
    if (!parent.gatewayAccountId) {
      const intent = await this.client().paymentIntents.retrieve(parent.gatewayTransactionId);
      if (intent.livemode !== (this.config.get<string>('STRIPE_MODE') === 'live') || intent.amount_received !== stripeMinorUnits(parent.amount, parent.currencyCode) || intent.currency.toUpperCase() !== parent.currencyCode) throw new ConflictException('Legacy Stripe payment requires reconciliation');
      await tx.update(payments).set({ gatewayAccountId: accountId }).where(and(eq(payments.id, id), eq(payments.propertyId, propertyId)));
    }
    return parent as typeof payments.$inferSelect;
  }
  async refund(id: string, propertyId: string, amount?: string, key?: string) {
    await assertStripeAccount(this.client(), this.config);
    if (amount !== undefined && !key) throw new ConflictException('Partial or explicit-amount Stripe refunds require an idempotency key');
    key ??= `full_${id}`;
    if (key && (key.length > 128 || !/^[A-Za-z0-9_:.-]+$/.test(key))) throw new ConflictException('Invalid refund idempotency key');
    const claim = await this.db.transaction(async (tx: any) => {
      const parent = await this.lockParent(tx, id, propertyId);
      if (!parent.gatewayTransactionId || !['captured', 'settled', 'partially_refunded', 'refunded'].includes(parent.status)) throw new ConflictException('Payment has no captured funds');
      const children = await tx.select().from(payments).where(and(eq(payments.originalPaymentId, id), eq(payments.propertyId, propertyId)));
      const identity = key ? `stripe_refund:${createHash('sha256').update(`${propertyId}:${key}`).digest('hex')}` : undefined;
      const replay = identity ? children.find((child: any) => child.idempotencyKey === identity) : children.find((child: any) => child.status === 'pending');
      if (replay) {
        if (amount && !new Decimal(replay.amount).abs().equals(amount)) throw new ConflictException('Refund key was already used for another amount');
        return replay;
      }
      const returned = sumRefundChildren(children.filter((child: any) => ['captured', 'settled'].includes(child.status)));
      const reserved = children.filter((child: any) => child.status === 'pending').reduce((sum: Decimal, child: any) => sum.plus(new Decimal(child.amount).abs()), new Decimal(0));
      const remaining = new Decimal(parent.amount).minus(returned).minus(reserved);
      const value = new Decimal(amount ?? remaining);
      if (!value.isFinite() || !value.greaterThan(0) || value.greaterThan(remaining)) throw new ConflictException('Refund exceeds available captured funds');
      stripeMinorUnits(value.toFixed(2), parent.currencyCode);
      if (!value.equals(value.toFixed(2))) throw new ConflictException('Refund exceeds ledger precision');
      const [row] = await tx.insert(payments).values({ propertyId, folioId: parent.folioId, originalPaymentId: parent.id,
        amount: value.negated().toFixed(2), currencyCode: parent.currencyCode, method: parent.method, gatewayProvider: 'stripe',
        status: 'pending', gatewayAccountId: parent.gatewayAccountId ?? this.config.get<string>('STRIPE_ACCOUNT_ID'), idempotencyKey: identity ?? `stripe_refund:${parent.id}:${returned.plus(reserved).plus(value).toFixed(2)}`,
        notes: 'Stripe refund pending provider settlement' }).returning();
      return row;
    });
    if (claim.status !== 'pending') return claim;
    if (!claim.gatewayTransactionId && Date.now() - new Date(claim.createdAt).getTime() > 23 * 60 * 60_000) throw new ConflictException('Old refund attempt requires provider reconciliation');
    const parent = await this.db.select().from(payments).where(and(eq(payments.id, id), eq(payments.propertyId, propertyId)));
    const refund = claim.gatewayTransactionId ? await this.client().refunds.retrieve(claim.gatewayTransactionId)
      : await this.client().refunds.create({ payment_intent: parent[0].gatewayTransactionId,
        amount: stripeMinorUnits(new Decimal(claim.amount).abs().toFixed(2), claim.currencyCode),
        metadata: { haip_refund_payment_id: claim.id, haip_payment_id: id, haip_property_id: propertyId } }, { idempotencyKey: `haip_refund_${claim.id}` });
    await this.db.transaction(async (tx: any) => {
      const consequences: any[] = [];
      await this.handleRefund(refund, tx, async (event, entityType, entityId, data, tenant) => { consequences.push({ event, entityType, entityId, data, propertyId: tenant }); });
      if (consequences.length) await this.events.enqueue(tx, `haip:refund:${claim.id}:${refund.status}`, consequences);
    });
    const [result] = await this.db.select().from(payments).where(and(eq(payments.id, claim.id), eq(payments.propertyId, propertyId)));
    return result;
  }

  async handleRefund(notification: Stripe.Refund, tx: any, emit: StripeEmit) {
    const claimId = notification.metadata?.['haip_refund_payment_id'];
    const propertyId = notification.metadata?.['haip_property_id'];
    const parentId = notification.metadata?.['haip_payment_id'];
    if (!claimId) { await this.handleExternalRefund(notification, tx, emit); return; }
    if (!propertyId || !parentId) throw new ConflictException('Incomplete refund metadata');
    const parent = await this.lockParent(tx, parentId, propertyId);
    const [claim] = await tx.select().from(payments).where(and(eq(payments.id, claimId), eq(payments.propertyId, propertyId))).for('update');
    if (!claim || claim.originalPaymentId !== parentId || claim.gatewayProvider !== 'stripe' || !new Decimal(claim.amount).isNegative()) throw new ConflictException('Refund correlation mismatch');
    const refund = await this.client().refunds.retrieve(notification.id);
    const intentId = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id;
    if (intentId !== parent.gatewayTransactionId || refund.currency.toUpperCase() !== claim.currencyCode
      || refund.amount !== stripeMinorUnits(new Decimal(claim.amount).abs().toFixed(2), claim.currencyCode)
      || refund.metadata?.['haip_refund_payment_id'] !== claim.id || refund.metadata?.['haip_payment_id'] !== parent.id
      || refund.metadata?.['haip_property_id'] !== propertyId || (claim.gatewayTransactionId && claim.gatewayTransactionId !== refund.id)) throw new ConflictException('Refund provider state mismatch');
    const intent = await this.client().paymentIntents.retrieve(intentId!);
    if (intent.livemode !== (this.config.get<string>('STRIPE_MODE') === 'live')) throw new ConflictException('Refund mode mismatch');
    if (claim.status === 'captured') return;
    const status = refund.status === 'succeeded' ? 'captured' : ['failed', 'canceled'].includes(refund.status ?? '') ? 'failed' : 'pending';
    const children = await tx.select().from(payments).where(and(eq(payments.originalPaymentId, parent.id), eq(payments.propertyId, propertyId)));
    if (status === 'captured' && sumRefundChildren(children.filter((child: any) => ['captured', 'settled'].includes(child.status))).plus(new Decimal(claim.amount).abs()).greaterThan(parent.amount)) throw new ConflictException('Refund ledger exceeds original payment');
    await tx.update(payments).set({ gatewayTransactionId: refund.id, status, processedAt: status === 'captured' ? new Date() : null,
      notes: `Stripe refund ${refund.status}`, updatedAt: new Date() }).where(and(eq(payments.id, claim.id), eq(payments.propertyId, propertyId)));
    if (status === 'captured') {
      if (parent.folioId) await this.folioService.recalculateBalance(parent.folioId, propertyId, tx);
      await emit('payment.refunded', 'payment', claim.id, { folioId: parent.folioId, originalPaymentId: parent.id,
        refundAmount: new Decimal(claim.amount).abs().toFixed(2) }, propertyId);
      // A full return of the linked advance also releases its liability exactly once.
      const total = sumRefundChildren(children.filter((child: any) => ['captured', 'settled'].includes(child.status))).plus(new Decimal(claim.amount).abs());
      const held = await tx.select().from(depositLedgerEntries).where(and(eq(depositLedgerEntries.paymentId, parent.id),
        eq(depositLedgerEntries.propertyId, propertyId), eq(depositLedgerEntries.status, 'held'))).for('update');
      for (const entry of held) {
        if (!new Decimal(entry.amount).equals(parent.amount) || !total.equals(parent.amount)) continue;
        await tx.update(depositLedgerEntries).set({ status: 'refunded', recognizedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(depositLedgerEntries.id, entry.id), eq(depositLedgerEntries.propertyId, propertyId), eq(depositLedgerEntries.status, 'held')));
        await emit('deposit.refunded', 'deposit', entry.id, { amount: entry.amount, status: 'refunded' }, propertyId);
      }
    }
  }
  private async handleExternalRefund(notification: Stripe.Refund, tx: any, emit: StripeEmit) {
    const intentId = typeof notification.payment_intent === 'string' ? notification.payment_intent : notification.payment_intent?.id;
    if (!intentId) return;
    // Global identity lookup is restricted to signature-verified provider notifications.
    const [reference] = await tx.select().from(payments).where(and(eq(payments.gatewayTransactionId, intentId),
      eq(payments.gatewayProvider, 'stripe'), isNull(payments.originalPaymentId)));
    if (!reference || reference.bookingRequestId) return;
    const parent = await this.lockParent(tx, reference.id, reference.propertyId);
    const refund = await this.client().refunds.retrieve(notification.id);
    if (refund.status !== 'succeeded') return; // Pending/failed provider refunds do not move the ledger.
    const verifiedIntent = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id;
    const intent = await this.client().paymentIntents.retrieve(intentId);
    if (verifiedIntent !== parent.gatewayTransactionId || refund.currency.toUpperCase() !== parent.currencyCode
      || intent.livemode !== (this.config.get<string>('STRIPE_MODE') === 'live')) throw new ConflictException('External refund correlation mismatch');
    const children = await tx.select().from(payments).where(and(eq(payments.originalPaymentId, parent.id), eq(payments.propertyId, parent.propertyId)));
    if (children.some((child: any) => child.gatewayTransactionId === refund.id)) return;
    const value = new Decimal(refund.amount).div(stripeMinorUnits('1.00', parent.currencyCode));
    const total = sumRefundChildren(children.filter((child: any) => ['captured', 'settled'].includes(child.status))).plus(value);
    if (!value.greaterThan(0) || total.greaterThan(parent.amount)) throw new ConflictException('External refund exceeds captured funds');
    const [child] = await tx.insert(payments).values({ propertyId: parent.propertyId, folioId: parent.folioId, originalPaymentId: parent.id,
      amount: value.negated().toFixed(2), currencyCode: parent.currencyCode, method: parent.method, status: 'captured', gatewayProvider: 'stripe',
      gatewayAccountId: parent.gatewayAccountId ?? this.config.get<string>('STRIPE_ACCOUNT_ID'), gatewayTransactionId: refund.id, idempotencyKey: `stripe_external_refund:${refund.id}`, processedAt: new Date(), notes: 'Verified external Stripe refund' }).returning();
    if (parent.folioId) await this.folioService.recalculateBalance(parent.folioId, parent.propertyId, tx);
    await emit('payment.refunded', 'payment', child.id, { folioId: parent.folioId, originalPaymentId: parent.id, refundAmount: value.toFixed(2) }, parent.propertyId);
    if (total.equals(parent.amount)) {
      const held = await tx.select().from(depositLedgerEntries).where(and(eq(depositLedgerEntries.paymentId, parent.id), eq(depositLedgerEntries.propertyId, parent.propertyId), eq(depositLedgerEntries.status, 'held'))).for('update');
      for (const entry of held) {
        if (!new Decimal(entry.amount).equals(parent.amount)) continue;
        await tx.update(depositLedgerEntries).set({ status: 'refunded', recognizedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(depositLedgerEntries.id, entry.id), eq(depositLedgerEntries.propertyId, parent.propertyId), eq(depositLedgerEntries.status, 'held')));
        await emit('deposit.refunded', 'deposit', entry.id, { amount: entry.amount, status: 'refunded' }, parent.propertyId);
      }
    }
  }
  async reconcilePayment(intentId: string, tx: any, emit: StripeEmit) {
    const refunds = await this.client().refunds.list({ payment_intent: intentId, limit: 100 });
    if (refunds.has_more) throw new ConflictException('Refund history requires provider reconciliation');
    for (const refund of refunds.data) await this.handleRefund(refund, tx, emit);
  }
  async reconcileCharge(charge: Stripe.Charge, tx: any, emit: StripeEmit) {
    const id = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    if (!id) return;
    await this.reconcilePayment(id, tx, emit);
  }
}

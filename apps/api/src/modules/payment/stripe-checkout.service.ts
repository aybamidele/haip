import { assertStripeAccount } from './stripe-context';
import { StripeRefundService } from './stripe-refund.service';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, lte, isNotNull, isNull, inArray } from 'drizzle-orm';
import { depositLedgerEntries, payments, reservations, stripeCheckouts } from '@telivityhaip/database';
import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { DRIZZLE } from '../../database/database.module';
import { FolioService } from '../folio/folio.service';
import { BookingReturnService } from '../booking-engine/booking-return.service';
import { stripeMinorUnits } from './stripe-money';
import type { StripeEmit } from './stripe-event.service';

@Injectable()
export class StripeCheckoutService {
  private readonly logger = new Logger(StripeCheckoutService.name);
  private readonly stripe: Stripe | null;
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly config: ConfigService,
    private readonly folios: FolioService, @Optional() private readonly refunds?: StripeRefundService) {
    const key = config.get<string>('STRIPE_SECRET_KEY');
    this.stripe = key ? new Stripe(key, { typescript: true, timeout: 10_000, maxNetworkRetries: 2 }) : null;
  }
  private client(): Stripe {
    if (!this.stripe) throw new ServiceUnavailableException('Stripe Checkout is not configured');
    return this.stripe;
  }
  async prepare(returnUrl?: string) {
    const stripeAccountId = await assertStripeAccount(this.client(), this.config);
    const url = new BookingReturnService(this.db, this.config).validateDestination(returnUrl);
    const minutes = Number(this.config.get<string>('BOOKING_CARD_HOLD_MINUTES', '30'));
    if (!Number.isInteger(minutes) || minutes < 30 || minutes > 1440) throw new BadRequestException('Invalid card hold configuration');
    return { stripeAccountId, returnUrl: url.href, expiresAt: new Date(Date.now() + minutes * 60_000) };
  }
  async createPending(tx: any, input: typeof stripeCheckouts.$inferInsert) {
    const [row] = await tx.insert(stripeCheckouts).values(input).returning();
    return row as typeof stripeCheckouts.$inferSelect;
  }
  async resume(propertyId: string, paymentId: string) {
    const stripeAccountId = await assertStripeAccount(this.client(), this.config);
    return this.db.transaction(async (tx: any) => {
      const [row] = await tx.select().from(stripeCheckouts).where(and(eq(stripeCheckouts.propertyId, propertyId),
        eq(stripeCheckouts.paymentId, paymentId))).for('update');
      if (!row) throw new BadRequestException('Checkout not found');
      if (row.stripeAccountId !== stripeAccountId) throw new ConflictException('Checkout belongs to another Stripe account');
      if (row.closedAt || new Date(row.expiresAt) <= new Date()) throw new ConflictException('Booking hold is no longer payable');
      if (row.sessionId) {
        // The same attempt never creates a replacement session or consumes more stock.
        return { url: row.sessionUrl, sessionId: row.sessionId, expiresAt: row.expiresAt };
      }
      const [reservation] = await tx.select().from(reservations).where(and(eq(reservations.id, row.reservationId),
        eq(reservations.propertyId, propertyId))).for('update');
      if (!reservation || reservation.status !== 'pending' || new Date(row.expiresAt) <= new Date()) {
        throw new ConflictException('Booking hold is no longer payable');
      }
      const [payment] = await tx.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.propertyId, propertyId)));
      if (!payment || payment.status !== 'pending') throw new ConflictException('Checkout payment changed');
      const metadata = { haip_checkout_id: row.id, haip_payment_id: paymentId, haip_property_id: propertyId,
        haip_reservation_id: row.reservationId };
      const suffix = createHash('sha256').update(row.id).digest('hex').slice(0, 8)
        .replace(/[0-9a-f]/g, character => 'abcdefghijklmnop'[parseInt(character, 16)]!);
      const session = await this.client().checkout.sessions.create({
        mode: 'payment', ui_mode: 'hosted', client_reference_id: paymentId,
        success_url: row.returnUrl, cancel_url: row.returnUrl,
        // Inventory expiry is enforced by HAIP maintenance using sessions.expire.
        // Keep creation parameters immutable across an ambiguous provider retry.
        integration_identifier: `haip_direct_${suffix}`,
        metadata, payment_intent_data: { metadata, capture_method: 'automatic' },
        line_items: [{ quantity: 1, price_data: { currency: payment.currencyCode.toLowerCase(),
          unit_amount: stripeMinorUnits(payment.amount, payment.currencyCode),
          product_data: { name: 'Accommodation booking payment' } } }],
        ...(this.config.get<string>('STRIPE_CHECKOUT_INVOICES') === 'true'
          ? { invoice_creation: { enabled: true, invoice_data: { metadata } } } : {}),
      }, { idempotencyKey: `haip_checkout_${row.id}` });
      if (!session.url || session.livemode !== (this.config.get<string>('STRIPE_MODE') === 'live')) {
        throw new ConflictException('Unexpected Stripe Checkout response');
      }
      await tx.update(stripeCheckouts).set({ sessionId: session.id, sessionUrl: session.url })
        .where(and(eq(stripeCheckouts.id, row.id), eq(stripeCheckouts.propertyId, propertyId)));
      return { url: session.url, sessionId: session.id, expiresAt: row.expiresAt };
    });
  }

  async handleSession(notification: Stripe.Checkout.Session, tx: any, emit: StripeEmit) {
    const stripeAccountId = await assertStripeAccount(this.client(), this.config);
    const propertyId = notification.metadata?.['haip_property_id'];
    const checkoutId = notification.metadata?.['haip_checkout_id'];
    if (!propertyId || !checkoutId) return; // Other Stripe integrations in the account.
    const [row] = await tx.select().from(stripeCheckouts).where(and(eq(stripeCheckouts.id, checkoutId),
      eq(stripeCheckouts.propertyId, propertyId))).for('update');
    if (!row) throw new ConflictException('Checkout correlation not committed');
    if (row.stripeAccountId !== stripeAccountId) throw new ConflictException('Checkout belongs to another Stripe account');
    if (row.sessionId && row.sessionId !== notification.id) throw new ConflictException('Checkout identity mismatch');
    // Read current provider state, so an older failure/expiry notification cannot undo a later success.
    const session = await this.client().checkout.sessions.retrieve(notification.id);
    const [reservation] = await tx.select().from(reservations).where(and(eq(reservations.id, row.reservationId),
      eq(reservations.propertyId, propertyId))).for('update');
    const [payment] = await tx.select().from(payments).where(and(eq(payments.id, row.paymentId),
      eq(payments.propertyId, propertyId))).for('update');
    if (!payment || !reservation || session.mode !== 'payment' || session.client_reference_id !== payment.id
      || session.metadata?.['haip_checkout_id'] !== row.id || session.metadata?.['haip_property_id'] !== propertyId
      || session.metadata?.['haip_payment_id'] !== payment.id || session.metadata?.['haip_reservation_id'] !== reservation.id
      || session.currency?.toUpperCase() !== payment.currencyCode || session.amount_total !== stripeMinorUnits(payment.amount, payment.currencyCode)
      || session.livemode !== (this.config.get<string>('STRIPE_MODE') === 'live')) {
      throw new ConflictException('Checkout provider state does not match the booking');
    }
    await tx.update(stripeCheckouts).set({ sessionId: session.id, sessionUrl: session.url ?? row.sessionUrl })
      .where(and(eq(stripeCheckouts.id, row.id), eq(stripeCheckouts.propertyId, propertyId)));
    if (session.payment_status !== 'paid') return;
    const intent = await this.client().paymentIntents.retrieve(typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? '');
    if (intent.status !== 'succeeded' || intent.amount_received !== session.amount_total || intent.currency !== session.currency || intent.livemode !== session.livemode) throw new ConflictException('Checkout has no matching successful payment');
    const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (!intentId) throw new ConflictException('Paid Checkout has no PaymentIntent');
    if (payment.gatewayTransactionId && payment.gatewayTransactionId !== intentId) throw new ConflictException('Checkout PaymentIntent mismatch');
    await tx.update(stripeCheckouts).set({ closedAt: new Date() }).where(and(eq(stripeCheckouts.id, row.id), eq(stripeCheckouts.propertyId, propertyId)));
    if (['captured', 'settled', 'refunded', 'partially_refunded'].includes(payment.status)) return;
    await tx.update(payments).set({ status: 'captured', gatewayTransactionId: intentId, gatewayAccountId: stripeAccountId,
      processedAt: new Date(), updatedAt: new Date() }).where(and(eq(payments.id, payment.id), eq(payments.propertyId, propertyId)));
    await this.folios.recalculateBalance(payment.folioId, propertyId, tx);
    const [deposit] = await tx.insert(depositLedgerEntries).values({ propertyId, reservationId: reservation.id,
      paymentId: payment.id, amount: payment.amount, currencyCode: payment.currencyCode,
      status: 'held', isRefundable: row.refundable }).returning();
    await emit('payment.received', 'payment', payment.id, { folioId: payment.folioId, amount: payment.amount, status: 'captured' }, propertyId);
    await emit('deposit.received', 'deposit', deposit.id, { amount: deposit.amount, status: 'held', isRefundable: row.refundable }, propertyId);
    await this.refunds?.reconcilePayment(intentId, tx, emit);
    const returned = await tx.select().from(payments).where(and(eq(payments.originalPaymentId, payment.id), eq(payments.propertyId, propertyId), inArray(payments.status, ['captured', 'settled'])));
    const refundRecorded = returned.length > 0;
    if (!refundRecorded && reservation.status === 'pending' && reservation.holdExpiresAt && new Date(reservation.holdExpiresAt) > new Date()) {
      await tx.update(reservations).set({ status: row.autoConfirm ? 'confirmed' : 'pending', holdExpiresAt: null, updatedAt: new Date() })
        .where(and(eq(reservations.id, reservation.id), eq(reservations.propertyId, propertyId), eq(reservations.status, 'pending')));
      if (row.autoConfirm) await emit('reservation.confirmed', 'reservation', reservation.id, { reservationId: reservation.id }, propertyId);
    } else if (refundRecorded || reservation.status !== 'confirmed') {
      await tx.update(stripeCheckouts).set({ reconciliationRequired: true })
        .where(and(eq(stripeCheckouts.id, row.id), eq(stripeCheckouts.propertyId, propertyId)));
      // Record real money without reviving released inventory. Staff sees this on the payment/folio.
      await tx.update(payments).set({ notes: refundRecorded ? 'Checkout already refunded; reservation reconciliation required' : 'Paid after booking hold expired or reservation changed; reconciliation required' })
        .where(and(eq(payments.id, payment.id), eq(payments.propertyId, propertyId)));
    }
  }

  /** Provider session expiry is retried each sweep; local inventory expiry is independent. */
  async expireSessions() {
    if (!this.stripe) return;
    const stripeAccountId = await assertStripeAccount(this.stripe, this.config);
    const rows = await this.db.select().from(stripeCheckouts).innerJoin(payments,
      and(eq(payments.id, stripeCheckouts.paymentId), eq(payments.propertyId, stripeCheckouts.propertyId)))
      .where(and(lte(stripeCheckouts.expiresAt, new Date()), isNotNull(stripeCheckouts.sessionId), isNull(stripeCheckouts.closedAt), inArray(payments.status, ['pending', 'failed', 'voided']))).limit(100);
    for (const entry of rows) {
      const row = entry.stripe_checkouts;
      try {
        if (row.stripeAccountId !== stripeAccountId) continue;
        const session = await this.stripe.checkout.sessions.retrieve(row.sessionId!);
        if (session.status === 'open') await this.stripe.checkout.sessions.expire(session.id, {}, { idempotencyKey: `haip_expire_${row.id}` });
        if (session.payment_status !== 'paid' && session.status !== 'complete') await this.db.update(stripeCheckouts).set({ closedAt: new Date() })
          .where(and(eq(stripeCheckouts.id, row.id), eq(stripeCheckouts.propertyId, row.propertyId)));
      } catch { this.logger.warn({ event: 'stripe_checkout_expiry_pending', checkoutId: row.id }); }
    }
  }
}

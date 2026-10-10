import { StripeRefundService } from './stripe-refund.service';
import {
  Controller,
  Post,
  Req,
  Res,
  Logger,
  BadRequestException,
  Inject,
  Optional,
  ServiceUnavailableException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { eq, and, inArray } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { payments, stripeCheckouts, stripeInvoices } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { WebhookService } from '../webhook/webhook.service';
import { FolioService } from '../folio/folio.service';
import { sumRefundChildren } from './payment-ledger';
import {
  BOOKING_REQUEST_STRIPE_HANDLER,
  paymentHasBookingRequestId,
  type BookingRequestStripeHandler,
  type BookingRequestStripePaymentRow,
} from './booking-request-stripe-handler.interface';
import { classifyHaipMetadata } from './stripe-financial-state';
import { StripeInvoiceService } from './stripe-invoice.service';
import { StripeCheckoutService } from './stripe-checkout.service';
import { StripeEventService, type StripeEmit } from './stripe-event.service';
import { stripeMinorUnits, stripeMajorUnits } from './stripe-money';
import Stripe from 'stripe';

/**
 * Stripe Webhook Controller.
 *
 * Handles asynchronous payment status updates from Stripe.
 * Uses raw body for signature verification (Stripe requirement).
 *
 * Events handled:
 * - payment_intent.succeeded → captured
 * - payment_intent.payment_failed → failed
 * - payment_intent.canceled → voided
 * - charge.refunded → refunded
 */
@ApiTags('webhooks')
@Controller('webhooks/stripe')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);
  private stripe: Stripe | null = null;
  private webhookSecret: string | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly webhookService: WebhookService,
    private readonly folioService: FolioService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(BOOKING_REQUEST_STRIPE_HANDLER)
    private readonly bookingRequestStripeHandler?: BookingRequestStripeHandler,
    @Optional() private readonly stripeEvents?: StripeEventService,
    @Optional() private readonly checkoutService?: StripeCheckoutService,
    @Optional() private readonly invoiceService?: StripeInvoiceService,
    @Optional() private readonly refundService?: StripeRefundService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    this.webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET') ?? null;

    if (secretKey) {
      this.stripe = new Stripe(secretKey, {
          typescript: true,
      });
    }
  }

  @Public()
  @Post()
  @ApiExcludeEndpoint() // Hide from Swagger — this is for Stripe only
  async handleWebhook(@Req() req: any, @Res() res: any) {
    const stripeMode = this.configService.get<string>('STRIPE_MODE', 'mock');

    if (stripeMode === 'mock') {
      // In mock mode, webhooks are not processed
      return res.status(200).json({ received: true, mode: 'mock' });
    }

    if (!this.stripe) throw new ServiceUnavailableException('Stripe webhook is not configured');

    // Verify webhook signature
    const signature = req.headers['stripe-signature'] as string;
    if (!signature || !this.webhookSecret) {
      throw new BadRequestException('Missing Stripe signature or webhook secret');
    }

    let event: Stripe.Event;
    try {
      // Stripe requires the exact raw request body for signature verification.
      // main.ts installs express.raw({ type: 'application/json' }) for this
      // route, which places the raw Buffer on req.body (and also exposes it
      // via req.rawBody on some Nest versions). Prefer the Buffer from req.body;
      // fall back to req.rawBody to stay resilient across middleware orders.
      const rawBody: Buffer | string | undefined = Buffer.isBuffer(req.body)
        ? (req.body as Buffer)
        : ((req as any).rawBody as Buffer | string | undefined);
      if (!rawBody) {
        throw new Error(
          'Raw body not available. Ensure express.raw() middleware is configured for /api/v1/webhooks/stripe in main.ts.',
        );
      }
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (err: any) {
      this.logger.warn({ event: 'stripe_webhook_signature_rejected' });
      throw new BadRequestException('Invalid Stripe webhook signature');
    }

    this.logger.log(`Stripe webhook received: ${event.type} (${event.id})`);

    try {
      await (this.stripeEvents ?? new StripeEventService(this.db, this.webhookService)).process(event, async (tx, emit) => {
      switch (event.type) {
        case 'invoice.paid':
        case 'invoice.payment_failed':
        case 'invoice.voided':
        case 'invoice.marked_uncollectible':
          if (!this.invoiceService) throw new Error('Stripe invoice handler is not registered');
          await this.invoiceService.handleInvoice(event.data.object as Stripe.Invoice, tx, emit);
          break;
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
        case 'checkout.session.async_payment_failed':
        case 'checkout.session.expired':
          if (!this.checkoutService) throw new Error('Stripe Checkout handler is not registered');
          await this.checkoutService.handleSession(event.data.object as Stripe.Checkout.Session, tx, emit);
          break;
        case 'payment_intent.succeeded':
          await this.handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent, tx, emit);
          break;

        case 'payment_intent.payment_failed':
          await this.handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent, tx, emit);
          break;

        case 'payment_intent.canceled':
          await this.handlePaymentIntentCanceled(event.data.object as Stripe.PaymentIntent, tx, emit);
          break;

        case 'payment_intent.processing':
          await this.handlePaymentIntentProcessing(event.data.object as Stripe.PaymentIntent, tx, emit);
          break;

        case 'payment_intent.requires_action':
          await this.handlePaymentIntentRequiresAction(event.data.object as Stripe.PaymentIntent, tx, emit);
          break;

        case 'refund.created':
        case 'refund.updated':
        case 'refund.failed':
          await this.handleRefundUpdated(event.data.object as Stripe.Refund, tx, emit);
          break;

        case 'charge.refunded':
          await this.handleChargeRefunded(event.data.object as Stripe.Charge, tx, emit);
          break;

        default:
          this.logger.debug(`Unhandled event type: ${event.type}`);
      }
      });
    } catch (err: any) {
      this.logger.error({ event: 'stripe_webhook_processing_failed', eventId: event.id, eventType: event.type });
      throw new ServiceUnavailableException('Stripe event processing failed; retry delivery');
    }

    return res.status(200).json({ received: true });
  }

  private async handlePaymentIntentSucceeded(pi: Stripe.PaymentIntent, db = this.db, emit: StripeEmit = this.webhookService.emit.bind(this.webhookService)) {
    await this.transitionIntent(pi, 'captured', db, emit);
  }

  private async handlePaymentIntentFailed(pi: Stripe.PaymentIntent, db = this.db, emit: StripeEmit = this.webhookService.emit.bind(this.webhookService)) {
    await this.transitionIntent(pi, 'failed', db, emit);
  }

  private async handlePaymentIntentCanceled(pi: Stripe.PaymentIntent, db = this.db, emit: StripeEmit = this.webhookService.emit.bind(this.webhookService)) {
    await this.transitionIntent(pi, 'voided', db, emit);
  }

  private async transitionIntent(pi: Stripe.PaymentIntent, target: 'captured' | 'failed' | 'voided', db: any, emit: StripeEmit) {
    const payment = await this.resolvePaymentForIntent(pi, db);
    if (!payment) return;
    if (this.shouldDelegateToBookingRequestHandler(payment)) {
      // The optional package already commits its own idempotent ledger/consequences.
      if (target === 'captured') await this.bookingRequestStripeHandler!.handlePaymentIntentSucceeded(pi, payment);
      else if (target === 'failed') await this.bookingRequestStripeHandler!.handlePaymentIntentFailed(pi, payment);
      else await this.bookingRequestStripeHandler!.handlePaymentIntentCanceled(pi, payment);
      return;
    }
    const [checkout] = await db.select({ id: stripeCheckouts.id }).from(stripeCheckouts).where(and(eq(stripeCheckouts.paymentId, payment.id), eq(stripeCheckouts.propertyId, payment.propertyId)));
    if (checkout) return; // Checkout reconciliation owns capture + reservation + deposit in one transaction.
    const [invoice] = await db.select({ id: stripeInvoices.id }).from(stripeInvoices).where(and(eq(stripeInvoices.paymentId, payment.id), eq(stripeInvoices.propertyId, payment.propertyId)));
    if (invoice) return; // invoice.paid owns invoice settlement.
    if (pi.currency?.toUpperCase() !== payment.currencyCode?.toUpperCase()
      || pi.amount !== stripeMinorUnits(payment.amount, payment.currencyCode)) {
      throw new ConflictException('Stripe payment does not match the ledger amount and currency');
    }
    if (payment.status === target || ['captured', 'settled', 'refunded', 'partially_refunded'].includes(payment.status)) return;
    // Failed card attempts may subsequently succeed on the same Intent; terminal
    // cancellation cannot be reversed by an older provider notification.
    const allowed = target === 'captured' ? ['pending', 'authorized', 'failed'] : ['pending', 'authorized'];
    if (!allowed.includes(payment.status)) return;
    const [updated] = await db.update(payments).set({ status: target,
      gatewayTransactionId: pi.id, processedAt: target === 'captured' ? new Date() : null,
      updatedAt: new Date() }).where(and(eq(payments.id, payment.id), eq(payments.propertyId, payment.propertyId),
        inArray(payments.status, allowed as any))).returning();
    if (!updated) return;
    if (payment.folioId) await this.folioService.recalculateBalance(payment.folioId, payment.propertyId, db);
    await emit(target === 'captured' ? 'payment.received' : 'payment.failed', 'payment', payment.id,
      { folioId: payment.folioId, status: target, stripeEvent: pi.id,
        ...(target === 'failed' ? { error: pi.last_payment_error?.message ?? 'Payment failed' } : {}) }, payment.propertyId);
  }

  private async handlePaymentIntentProcessing(pi: Stripe.PaymentIntent, db = this.db, _emit?: StripeEmit) {
    if (!this.bookingRequestStripeHandler) return;
    const payment = await this.findPaymentByGatewayTransactionId(pi.id, db);
    if (payment && !this.shouldDelegateToBookingRequestHandler(payment)) return;
    await this.bookingRequestStripeHandler.handlePaymentIntentProcessing(
      pi,
      payment ?? this.placeholderPaymentRow(),
    );
  }

  private async handlePaymentIntentRequiresAction(pi: Stripe.PaymentIntent, db = this.db, _emit?: StripeEmit) {
    if (!this.bookingRequestStripeHandler) return;
    const payment = await this.findPaymentByGatewayTransactionId(pi.id, db);
    if (payment && !this.shouldDelegateToBookingRequestHandler(payment)) return;
    await this.bookingRequestStripeHandler.handlePaymentIntentRequiresAction(
      pi,
      payment ?? this.placeholderPaymentRow(),
    );
  }

  private async handleRefundUpdated(refund: Stripe.Refund, tx?: any, emit?: StripeEmit) {
    if (refund.metadata?.['haip_refund_payment_id']) {
      if (!this.refundService || !tx || !emit) throw new Error('Stripe refund handler is not registered');
      await this.refundService.handleRefund(refund, tx, emit);
      return;
    }
    if (this.refundService && tx && emit) await this.refundService.handleRefund(refund, tx, emit);
    if (!this.bookingRequestStripeHandler) return;
    await this.bookingRequestStripeHandler.handleRefundUpdated(refund);
  }

  private placeholderPaymentRow(): BookingRequestStripePaymentRow {
    return {
      id: '',
      propertyId: '',
      folioId: null,
      status: 'pending',
      amount: '0.00',
      currencyCode: 'USD',
      method: 'credit_card',
      gatewayProvider: 'stripe',
      gatewayTransactionId: null,
    };
  }

  private async handleChargeRefunded(charge: Stripe.Charge, db = this.db, emit: StripeEmit = this.webhookService.emit.bind(this.webhookService)) {
    const piId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;

    if (!piId) return;

    const payment = await this.findPaymentByGatewayTransactionId(piId, db);
    if (!payment) return;

    if (this.shouldDelegateToBookingRequestHandler(payment)) {
      await this.bookingRequestStripeHandler!.handleChargeRefunded(charge, payment);
      return;
    }

    if (this.refundService && db !== this.db) { await this.refundService.reconcileCharge(charge, db, emit); return; }
    if (charge.currency?.toUpperCase() !== payment.currencyCode || charge.amount_refunded > stripeMinorUnits(payment.amount, payment.currencyCode)) throw new ConflictException('Refund charge amount or currency mismatch');
    const stripeRefundedDec = new Decimal(stripeMajorUnits(charge.amount_refunded, payment.currencyCode));
    const ledgerKey = `stripe_refund:${charge.id}:${stripeRefundedDec.toFixed(2)}`;

    const recordRefund = async (tx: any) => {
      const [parent] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.id, payment.id),
            eq(payments.propertyId, payment.propertyId),
          ),
        )
        .for('update');

      if (!parent) return null;

      const [existingForLedger] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.gatewayTransactionId, ledgerKey), eq(payments.propertyId, payment.propertyId)))
        .limit(1);
      if (existingForLedger) {
        return null;
      }

      const existingRefunds = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.originalPaymentId, parent.id),
            eq(payments.propertyId, parent.propertyId),
          ),
        );

      const alreadyRefundedDec = sumRefundChildren((existingRefunds ?? []).filter((child: any) => !child.status || ['captured', 'settled'].includes(child.status)));
      const deltaDec = stripeRefundedDec.minus(alreadyRefundedDec);

      if (deltaDec.lte(0)) {
        this.logger.debug(
          `Payment ${parent.id} Stripe refund already recorded (${stripeRefundedDec.toFixed(2)})`,
        );
        return null;
      }

      const [row] = await tx
        .insert(payments)
        .values({
          folioId: parent.folioId,
          propertyId: parent.propertyId,
          method: parent.method,
          amount: deltaDec.negated().toFixed(2),
          currencyCode: parent.currencyCode,
          status: 'captured',
          originalPaymentId: parent.id,
          gatewayProvider: parent.gatewayProvider,
          gatewayTransactionId: ledgerKey,
          processedAt: new Date(),
          notes: `Stripe refund ${charge.id}`,
        })
        .returning();

      await this.folioService.recalculateBalance(parent.folioId, parent.propertyId, tx);
      return { row, parent, deltaDec };
    };
    const recorded = db === this.db ? await this.db.transaction(recordRefund) : await recordRefund(db);

    if (!recorded) return;

    await emit(
      'payment.refunded',
      'payment',
      recorded.row.id,
      {
        folioId: recorded.parent.folioId,
        originalPaymentId: recorded.parent.id,
        refundAmount: recorded.deltaDec.toFixed(2),
        stripeEvent: charge.id,
      },
      recorded.parent.propertyId,
    );

    this.logger.log(
      `Payment ${recorded.parent.id} refund child ${recorded.row.id} recorded via webhook (${recorded.deltaDec.toFixed(2)})`,
    );
  }

  /**
   * Correlate a PaymentIntent to a HAIP payment row. Lookup by gateway id first
   * so legacy instant-booking intents without haip_* metadata still reconcile;
   * only unmatched intents with no HAIP metadata are treated as external noise.
   */
  private async resolvePaymentForIntent(pi: Stripe.PaymentIntent, db = this.db) {
    const payment = await this.findPaymentByGatewayTransactionId(pi.id, db);
    if (payment) return payment;
    const propertyId = pi.metadata?.['haip_property_id'];
    const paymentId = pi.metadata?.['haip_payment_id'];
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (propertyId && paymentId && uuid.test(propertyId) && uuid.test(paymentId)) {
      const [correlated] = await db.select().from(payments).where(and(eq(payments.id, paymentId),
        eq(payments.propertyId, propertyId), eq(payments.gatewayProvider, 'stripe'))).for('update');
      if (correlated && (!correlated.gatewayTransactionId || correlated.gatewayTransactionId === pi.id)) return correlated;
    }
    if (classifyHaipMetadata(pi.metadata) === 'external') return null;
    throw new ConflictException('Owned Stripe payment is not yet correlated');
  }

  private async findPaymentByGatewayTransactionId(transactionId: string, db = this.db) {
    // Signed server notification is the sole unscoped lookup; all subsequent writes are tenant scoped.
    const [payment] = await db.select().from(payments)
      .where(and(eq(payments.gatewayTransactionId, transactionId), eq(payments.gatewayProvider, 'stripe')));
    return (payment ?? null) as BookingRequestStripePaymentRow | null;
  }

  private shouldDelegateToBookingRequestHandler(
    payment: BookingRequestStripePaymentRow,
  ): payment is BookingRequestStripePaymentRow & { bookingRequestId: string } {
    return paymentHasBookingRequestId(payment) && !!this.bookingRequestStripeHandler;
  }
}

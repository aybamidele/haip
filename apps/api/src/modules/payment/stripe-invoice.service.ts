import { assertStripeAccount } from './stripe-context';
import { StripeRefundService } from './stripe-refund.service';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray } from 'drizzle-orm';
import { fiscalDocuments, folios, guests, payments, stripeInvoices } from '@telivityhaip/database';
import Decimal from 'decimal.js';
import Stripe from 'stripe';
import { DRIZZLE } from '../../database/database.module';
import { FolioService } from '../folio/folio.service';
import { StripeEventService, type StripeEmit } from './stripe-event.service';
import { stripeMinorUnits } from './stripe-money';
import type { CreateStripeInvoiceDto } from './dto/stripe-invoice.dto';

@Injectable()
export class StripeInvoiceService {
  private readonly stripe: Stripe | null;
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly config: ConfigService,
    private readonly folioService: FolioService, private readonly events: StripeEventService, @Optional() private readonly refunds?: StripeRefundService) {
    const key = config.get<string>('STRIPE_SECRET_KEY');
    this.stripe = key ? new Stripe(key, { typescript: true, timeout: 10_000, maxNetworkRetries: 2 }) : null;
  }
  private client() {
    if (!this.stripe || this.config.get<string>('STRIPE_MODE', 'mock') === 'mock') throw new ServiceUnavailableException('Stripe invoicing is not configured');
    return this.stripe;
  }
  async read(id: string, propertyId: string) {
    const [row] = await this.db.select().from(stripeInvoices).where(and(eq(stripeInvoices.id, id), eq(stripeInvoices.propertyId, propertyId)));
    if (!row) throw new NotFoundException('Stripe invoice not found');
    return row;
  }

  async create(dto: CreateStripeInvoiceDto) {
    const stripeAccountId = await assertStripeAccount(this.client(), this.config);
    if (!Number.isInteger(dto.dueDays) || dto.dueDays < 1 || dto.dueDays > 365) throw new BadRequestException('Invoice due days are required');
    const id = await this.db.transaction(async (tx: any) => {
      const [folio] = await tx.select().from(folios).where(and(eq(folios.id, dto.folioId), eq(folios.propertyId, dto.propertyId))).for('update');
      if (!folio) throw new NotFoundException('Folio not found');
      const [existing] = await tx.select().from(stripeInvoices).where(and(eq(stripeInvoices.documentId, dto.documentId), eq(stripeInvoices.propertyId, dto.propertyId)));
      if (existing) {
        if (existing.folioId !== dto.folioId || Number(existing.dueDays) !== dto.dueDays) throw new ConflictException('Invoice request changed');
        return existing.id;
      }
      const [document] = await tx.select().from(fiscalDocuments).where(and(eq(fiscalDocuments.id, dto.documentId),
        eq(fiscalDocuments.folioId, dto.folioId), eq(fiscalDocuments.propertyId, dto.propertyId))).for('update');
      if (!document || document.status !== 'requested' || document.documentType !== 'invoice') throw new BadRequestException('A requested invoice document is required');
      if (folio.status !== 'open') throw new BadRequestException('Folio must be open');
      const [pending] = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.folioId, dto.folioId),
        eq(payments.propertyId, dto.propertyId), inArray(payments.status, ['pending', 'authorized']))).limit(1);
      if (pending) throw new ConflictException('Resolve pending payments before creating an invoice');
      const [active] = await tx.select({ id: stripeInvoices.id }).from(stripeInvoices).where(and(eq(stripeInvoices.folioId, dto.folioId),
        eq(stripeInvoices.propertyId, dto.propertyId), inArray(stripeInvoices.status, ['creating', 'draft', 'open', 'uncollectible']))).limit(1);
      if (active) throw new ConflictException('A collectible invoice already exists for this folio');
      await this.folioService.recalculateBalance(dto.folioId, dto.propertyId, tx);
      const [current] = await tx.select().from(folios).where(and(eq(folios.id, dto.folioId), eq(folios.propertyId, dto.propertyId)));
      if (!new Decimal(current.balance).greaterThan(0)) throw new BadRequestException('Folio has no outstanding balance');
      stripeMinorUnits(current.balance, current.currencyCode);
      // Snapshot provider parameters before any remote mutation so retries stay identical.
      const [guest] = await tx.select().from(guests).where(eq(guests.id, folio.guestId));
      if (!guest?.email || guest.isDeleted) throw new BadRequestException('Invoice requires a valid guest billing contact');
      const [payment] = await tx.insert(payments).values({ propertyId: dto.propertyId, folioId: dto.folioId,
        amount: current.balance, currencyCode: current.currencyCode, method: 'credit_card', status: 'pending',
        gatewayProvider: 'stripe', gatewayAccountId: stripeAccountId, idempotencyKey: `invoice_${dto.documentId}` }).returning();
      const [row] = await tx.insert(stripeInvoices).values({ propertyId: dto.propertyId, folioId: dto.folioId,
        documentId: dto.documentId, paymentId: payment.id, amount: current.balance, currencyCode: current.currencyCode,
        stripeAccountId, dueDays: String(dto.dueDays), billingEmail: guest.email,
        billingName: [guest.firstName, guest.lastName].filter(Boolean).join(' '), description: `Outstanding folio ${folio.folioNumber}` }).returning();
      return row.id;
    });
    return this.prepareDraft(id, dto.propertyId);
  }

  private async prepareDraft(id: string, propertyId: string) {
    return this.db.transaction(async (tx: any) => {
      const row = await this.lockInvoice(tx, id, propertyId);
      if (row.invoiceId) return row;
      // Provider idempotency has a bounded lifetime. Never create fresh objects
      // for an old unresolved attempt whose cached response might have expired.
      if (Date.now() - new Date(row.createdAt).getTime() >= 23 * 60 * 60_000) throw new ConflictException('Old invoice attempt requires provider reconciliation');
      const metadata = { haip_invoice_id: row.id, haip_property_id: propertyId,
        haip_folio_id: row.folioId, haip_payment_id: row.paymentId, haip_document_id: row.documentId };
      const customer = await this.client().customers.create({ email: row.billingEmail,
        name: row.billingName, metadata }, { idempotencyKey: `haip_invoice_customer_${row.id}` });
      const invoice = await this.client().invoices.create({ customer: customer.id, currency: row.currencyCode.toLowerCase(),
        collection_method: 'send_invoice', days_until_due: Number(row.dueDays), auto_advance: false,
        pending_invoice_items_behavior: 'exclude', metadata }, { idempotencyKey: `haip_invoice_${row.id}` });
      if (invoice.livemode !== (this.config.get<string>('STRIPE_MODE') === 'live')) throw new ConflictException('Stripe invoice mode mismatch');
      await this.client().invoiceItems.create({ customer: customer.id, invoice: invoice.id,
        currency: row.currencyCode.toLowerCase(), amount: stripeMinorUnits(row.amount, row.currencyCode),
        description: row.description, metadata }, { idempotencyKey: `haip_invoice_item_${row.id}` });
      const [saved] = await tx.update(stripeInvoices).set({ customerId: customer.id, invoiceId: invoice.id, status: 'draft' })
        .where(and(eq(stripeInvoices.id, id), eq(stripeInvoices.propertyId, propertyId))).returning();
      return saved;
    });
  }

  private async lockInvoice(tx: any, id: string, propertyId: string) {
    const [reference] = await tx.select({ folioId: stripeInvoices.folioId }).from(stripeInvoices)
      .where(and(eq(stripeInvoices.id, id), eq(stripeInvoices.propertyId, propertyId)));
    if (!reference) throw new NotFoundException('Stripe invoice not found');
    await tx.select({ id: folios.id }).from(folios).where(and(eq(folios.id, reference.folioId), eq(folios.propertyId, propertyId))).for('update');
    const [row] = await tx.select().from(stripeInvoices).where(and(eq(stripeInvoices.id, id), eq(stripeInvoices.propertyId, propertyId))).for('update');
    if (row.stripeAccountId !== await assertStripeAccount(this.client(), this.config)) throw new ConflictException('Invoice belongs to another Stripe account');
    return row as typeof stripeInvoices.$inferSelect;
  }

  async send(id: string, propertyId: string) {
    return this.db.transaction(async (tx: any) => {
      const row = await this.lockInvoice(tx, id, propertyId);
      if (row.status === 'open') return row;
      if (!row.invoiceId || !['draft', 'open'].includes(row.status)) throw new ConflictException('Invoice is not ready to send');
      await this.folioService.recalculateBalance(row.folioId, propertyId, tx);
      const [folio] = await tx.select().from(folios).where(and(eq(folios.id, row.folioId), eq(folios.propertyId, propertyId)));
      if (folio.status !== 'open' || !new Decimal(folio.balance).equals(row.amount)) throw new ConflictException('Folio changed; void the draft and request a new invoice');
      const invoice = await this.client().invoices.retrieve(row.invoiceId);
      this.validateInvoice(invoice, row);
      if (invoice.status === 'draft') await this.client().invoices.finalizeInvoice(row.invoiceId, { auto_advance: false }, { idempotencyKey: `haip_invoice_finalize_${row.id}` });
      if (!['draft', 'open'].includes(invoice.status ?? '')) throw new ConflictException('Invoice already settled or voided; reconcile provider state');
      const sent = await this.client().invoices.sendInvoice(row.invoiceId, {}, { idempotencyKey: `haip_invoice_send_${row.id}` });
      const [saved] = await tx.update(stripeInvoices).set({ status: 'open', hostedUrl: sent.hosted_invoice_url ?? null })
        .where(and(eq(stripeInvoices.id, id), eq(stripeInvoices.propertyId, propertyId))).returning();
      await tx.update(fiscalDocuments).set({ status: 'issued', documentNumber: sent.number,
        documentUrl: sent.invoice_pdf ?? sent.hosted_invoice_url, issuedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(fiscalDocuments.id, row.documentId), eq(fiscalDocuments.folioId, row.folioId), eq(fiscalDocuments.propertyId, propertyId)));
      await this.events.enqueue(tx, `haip:invoice:issued:${row.id}`, [{ event: 'invoice.issued', entityType: 'fiscal_document',
        entityId: row.documentId, propertyId, data: { folioId: row.folioId, documentType: 'invoice', documentNumber: sent.number } }]);
      return saved;
    });
  }

  private validateInvoice(invoice: Stripe.Invoice, row: typeof stripeInvoices.$inferSelect) {
    if (invoice.id !== row.invoiceId || invoice.metadata?.['haip_invoice_id'] !== row.id
      || invoice.metadata?.['haip_property_id'] !== row.propertyId || invoice.metadata?.['haip_folio_id'] !== row.folioId
      || invoice.metadata?.['haip_payment_id'] !== row.paymentId || invoice.metadata?.['haip_document_id'] !== row.documentId
      || invoice.currency.toUpperCase() !== row.currencyCode || invoice.total !== stripeMinorUnits(row.amount, row.currencyCode)
      || invoice.livemode !== (this.config.get<string>('STRIPE_MODE') === 'live')) throw new ConflictException('Stripe invoice does not match the folio snapshot');
  }

  async handleInvoice(notification: Stripe.Invoice, tx: any, emit: StripeEmit) {
    const id = notification.metadata?.['haip_invoice_id'];
    const propertyId = notification.metadata?.['haip_property_id'];
    if (!id || !propertyId) return; // Includes Checkout post-payment documents: no second ledger credit.
    const row = await this.lockInvoice(tx, id, propertyId);
    if (!row.invoiceId) throw new ConflictException('Invoice correlation not committed');
    const invoice = await this.client().invoices.retrieve(notification.id);
    this.validateInvoice(invoice, row);
    if (invoice.status === 'paid' && row.status !== 'paid') {
      if (invoice.amount_paid !== stripeMinorUnits(row.amount, row.currencyCode) || invoice.amount_remaining !== 0) throw new ConflictException('Invoice settlement amount mismatch');
      const related = await this.client().invoicePayments.list({ invoice: invoice.id, limit: 100 });
      if (related.has_more) throw new ConflictException('Invoice payment history requires reconciliation');
      const providerIds = related.data.filter(item => item.status === 'paid').map(item => item.payment.payment_intent)
        .filter(Boolean).map(intent => typeof intent === 'string' ? intent : intent!.id);
      if (providerIds.length !== 1) throw new ConflictException('External or multiple invoice payments require explicit reconciliation');
      const intent = await this.client().paymentIntents.retrieve(providerIds[0]!);
      if (intent.status !== 'succeeded' || intent.amount_received !== stripeMinorUnits(row.amount, row.currencyCode)
        || intent.currency.toUpperCase() !== row.currencyCode || intent.livemode !== invoice.livemode) throw new ConflictException('Invoice has no matching successful payment');
      const [payment] = await tx.select().from(payments).where(and(eq(payments.id, row.paymentId), eq(payments.propertyId, propertyId))).for('update');
      if (!payment || payment.amount !== row.amount || payment.currencyCode !== row.currencyCode) throw new ConflictException('Invoice payment correlation mismatch');
      if (!['captured', 'settled', 'refunded', 'partially_refunded'].includes(payment.status)) {
        await tx.update(payments).set({ status: 'captured', gatewayTransactionId: intent.id, processedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(payments.id, row.paymentId), eq(payments.propertyId, propertyId)));
        await this.folioService.recalculateBalance(row.folioId, propertyId, tx);
        await emit('payment.received', 'payment', row.paymentId, { folioId: row.folioId, amount: row.amount, invoiceId: invoice.id, status: 'captured' }, propertyId);
        await this.refunds?.reconcilePayment(intent.id, tx, emit);
      }
    }
    if (['captured', 'paid'].includes(row.status) && invoice.status !== 'paid') return;
    await tx.update(stripeInvoices).set({ status: invoice.status ?? row.status, hostedUrl: invoice.hosted_invoice_url })
      .where(and(eq(stripeInvoices.id, id), eq(stripeInvoices.propertyId, propertyId)));
    if (invoice.status === 'void') {
      await tx.update(fiscalDocuments).set({ status: 'voided', voidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(fiscalDocuments.id, row.documentId), eq(fiscalDocuments.propertyId, propertyId)));
      if (row.status !== 'void') await emit('invoice.voided', 'fiscal_document', row.documentId, { folioId: row.folioId, documentType: 'invoice' }, propertyId);
      await tx.update(payments).set({ status: 'voided', updatedAt: new Date() })
        .where(and(eq(payments.id, row.paymentId), eq(payments.propertyId, propertyId), eq(payments.status, 'pending')));
    }
  }

  async void(id: string, propertyId: string) {
    return this.db.transaction(async (tx: any) => {
      const row = await this.lockInvoice(tx, id, propertyId);
      if (!row.invoiceId || !['draft', 'open', 'uncollectible', 'void'].includes(row.status)) throw new ConflictException('Invoice cannot be voided');
      if (row.status === 'void') return row;
      const invoice = row.status === 'draft' ? null : await this.client().invoices.retrieve(row.invoiceId);
      if (invoice) this.validateInvoice(invoice, row);
      if (invoice?.status === 'paid') throw new ConflictException('Paid invoices require refund and credit-note reconciliation');
      if (row.status === 'draft') {
        try { await this.client().invoices.del(row.invoiceId); }
        catch (error) { if (!(error instanceof Stripe.errors.StripeInvalidRequestError) || error.code !== 'resource_missing') throw error; }
      }
      else if (invoice?.status === 'open' || invoice?.status === 'uncollectible') await this.client().invoices.voidInvoice(row.invoiceId, {}, { idempotencyKey: `haip_invoice_void_${row.id}` });
      else if (invoice?.status !== 'void') throw new ConflictException('Provider invoice cannot be voided');
      const [saved] = await tx.update(stripeInvoices).set({ status: 'void', hostedUrl: null })
        .where(and(eq(stripeInvoices.id, id), eq(stripeInvoices.propertyId, propertyId))).returning();
      await tx.update(payments).set({ status: 'voided', updatedAt: new Date() })
        .where(and(eq(payments.id, row.paymentId), eq(payments.propertyId, propertyId), eq(payments.status, 'pending')));
      await tx.update(fiscalDocuments).set({ status: 'voided', voidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(fiscalDocuments.id, row.documentId), eq(fiscalDocuments.folioId, row.folioId), eq(fiscalDocuments.propertyId, propertyId)));
      await this.events.enqueue(tx, `haip:invoice:void:${row.id}`, [{ event: 'invoice.voided', entityType: 'fiscal_document',
        entityId: row.documentId, propertyId, data: { folioId: row.folioId, documentType: 'invoice' } }]);
      return saved;
    });
  }
}

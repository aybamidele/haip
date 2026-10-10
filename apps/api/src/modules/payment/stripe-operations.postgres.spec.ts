import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { properties, roomTypes, rooms, ratePlans, bookingEngineConfig, guests, reservations, bookings,
  folios, payments, charges, reservationGuests, stripeCheckouts, stripeInvoices, stripeWebhookEvents, directBookingAttempts,
  depositLedgerEntries, fiscalDocuments, auditLogs } from '@telivityhaip/database';
import { StripeEventService } from './stripe-event.service';
import { StripeCheckoutService } from './stripe-checkout.service';
import { StripeRefundService } from './stripe-refund.service';
import { StripeInvoiceService } from './stripe-invoice.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { PaymentService } from './payment.service';
import { BookingEngineService } from '../booking-engine/booking-engine.service';
import { BookingEngineConfigService } from '../booking-engine/booking-engine-config.service';
import { BookingMaintenanceService } from '../booking-engine/booking-maintenance.service';
import { AvailabilityService } from '../reservation/availability.service';
import { ReservationService } from '../reservation/reservation.service';
import { RatePlanService } from '../rate-plan/rate-plan.service';
import { FolioService } from '../folio/folio.service';
import { TaxService } from '../tax/tax.service';
import { AncillaryService } from '../ancillary/ancillary.service';
import { PolicyService } from '../policy/policy.service';
import { GuestService } from '../guest/guest.service';
import { DepositService } from '../accounting/deposit.service';

const url = process.env['DATABASE_URL'];
const suite = process.env['STRIPE_OPERATIONS_LIVE_PG'] === '1' && url ? describe : describe.skip;
suite('Stripe operations against real PostgreSQL (synthetic fixtures, simulated provider)', () => {
  const client = postgres(url!, { max: 12 });
  const db = drizzle(client);
  let propertyId: string, typeId: string, planId: string;
  const webhook = { emit: vi.fn().mockResolvedValue(undefined), dispatchPersisted: vi.fn().mockResolvedValue(undefined) };
  const config = new ConfigService({ PAYMENT_GATEWAY: 'stripe', STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_synthetic',
    STRIPE_WEBHOOK_SECRET: 'whsec_synthetic', STRIPE_ACCOUNT_ID: 'acct_synthetic', BOOKING_RETURN_ORIGINS: 'https://guest.example', BOOKING_CARD_HOLD_MINUTES: '30' });
  const tax = new TaxService(db);
  const folio = new FolioService(db, webhook as any, tax);
  const ancillary = new AncillaryService(db, folio, webhook as any);
  const availability = new AvailabilityService(db);
  const rates = new RatePlanService(db, webhook as any);
  const policy = new PolicyService(db, webhook as any);
  const reservation = new ReservationService(db, availability, folio, {} as any, {} as any,
    webhook as any, ancillary, policy, {} as any, rates);
  const events = new StripeEventService(db, webhook as any);
  const refunds = new StripeRefundService(db, config, folio, events);
  const checkout = new StripeCheckoutService(db, config, folio, refunds);
  const invoices = new StripeInvoiceService(db, config, folio, events, refunds);

  const deposits = new DepositService(db, webhook as any, folio);
  const payment = new PaymentService(db, folio, {} as any, webhook as any, config, {} as any, refunds);
  const engine = new BookingEngineService(db, {} as any, {} as any, reservation, availability, rates, tax,
    new GuestService(db), folio, payment, deposits, new BookingEngineConfigService(db, config), config,
    ancillary, policy, checkout, events);
  const remoteSessions = new Map<string, any>();
  const remoteRefunds = new Map<string, any>();
  let refundStatus = 'pending';
  const creations = new Map<string, any>();
  const provider = {
    accounts: { retrieve: vi.fn(async () => ({ id: 'acct_synthetic' })) },
    checkout: { sessions: {
      create: vi.fn(async (params: any, options: any) => {
        if (params.ui_mode !== 'hosted_page') throw new Error('Stripe 2026-09-30.endive requires hosted_page');
        if (!creations.has(options.idempotencyKey)) {
          const value = { id: `cs_test_${randomUUID()}`, url: 'https://checkout.stripe.com/c/pay/synthetic',
            ...params, currency: 'gbp', amount_total: params.line_items[0].price_data.unit_amount,
            payment_status: 'unpaid', status: 'open', livemode: false, payment_intent: null };
          creations.set(options.idempotencyKey, value); remoteSessions.set(value.id, value);
        }
        return creations.get(options.idempotencyKey);
      }),
      retrieve: vi.fn(async (id: string) => remoteSessions.get(id)),
      expire: vi.fn(async (id: string) => { const value = remoteSessions.get(id); value.status = 'expired'; return value; }),
    } },
    refunds: {
      create: vi.fn(async (params: any, options: any) => {
        const old = [...remoteRefunds.values()].find(value => value.key === options.idempotencyKey);
        if (old) return old;
        const value = { id: `re_${randomUUID()}`, ...params, key: options.idempotencyKey, currency: 'gbp', status: refundStatus };
        remoteRefunds.set(value.id, value); return value;
      }),
      retrieve: vi.fn(async (id: string) => remoteRefunds.get(id)),
      list: vi.fn(async (params: any) => ({ data: [...remoteRefunds.values()].filter(refund => refund.payment_intent === params.payment_intent), has_more: false })),
    },
    paymentIntents: { retrieve: vi.fn(async (id: string) => ({ id, status: 'succeeded', amount_received: 10000, currency: 'gbp', livemode: false })) },
  };
  beforeEach(async () => {
    vi.clearAllMocks(); webhook.dispatchPersisted.mockResolvedValue(undefined);
    creations.clear(); remoteSessions.clear(); remoteRefunds.clear(); refundStatus = 'pending';
    propertyId = randomUUID(); typeId = randomUUID(); planId = randomUUID();
    await db.insert(properties).values({ id: propertyId, name: 'Synthetic Stripe test only', code: `S${propertyId.slice(0, 7)}`,
      countryCode: 'GB', timezone: 'Europe/London', currencyCode: 'GBP', totalRooms: 1 });
    await db.insert(roomTypes).values({ id: typeId, propertyId, name: 'Synthetic room', code: 'SYN', maxOccupancy: 2, defaultOccupancy: 1 });
    await db.insert(rooms).values({ propertyId, roomTypeId: typeId, number: 'SYN-1', status: 'vacant_clean' });
    await db.insert(ratePlans).values({ id: planId, propertyId, roomTypeId: typeId, name: 'Synthetic rate', code: 'SYN',
      type: 'bar', baseAmount: '100.00', currencyCode: 'GBP' });
    await db.insert(bookingEngineConfig).values({ propertyId, isEnabled: true, bookingMode: 'instant', autoConfirm: true,
      allowManualPayments: true, sellableRoomTypeIds: [typeId], sellableRatePlanIds: [planId], depositPolicy: { type: 'full', refundable: true } });
    Reflect.set(checkout, 'stripe', provider); Reflect.set(refunds, 'stripe', provider);
  });
  afterEach(async () => {
    const guestIds = (await db.select({ id: reservations.guestId }).from(reservations).where(eq(reservations.propertyId, propertyId))).map(r => r.id);
    for (const table of [stripeWebhookEvents, auditLogs, directBookingAttempts, stripeCheckouts, stripeInvoices, fiscalDocuments,
      depositLedgerEntries, charges, payments, folios, reservationGuests, reservations, bookings, bookingEngineConfig, rooms, ratePlans, roomTypes]) {
      await db.delete(table).where(eq(table.propertyId, propertyId));
    }
    await db.delete(properties).where(eq(properties.id, propertyId));
    for (const id of guestIds) await db.delete(guests).where(eq(guests.id, id));
  });
  afterAll(async () => client.end());
  const request = (key = randomUUID()) => ({ roomTypeId: typeId, ratePlanId: planId, checkIn: '2027-01-20', checkOut: '2027-01-21',
    adults: 1, guestFirstName: 'Synthetic', guestLastName: 'Fixture', guestEmail: 'fixture@example.invalid',
    paymentMethod: 'card', expectedTotal: '100.00', idempotencyKey: key, returnUrl: 'https://guest.example/checkout/return?attempt=synthetic' } as any);
  const event = (id = `evt_${randomUUID()}`) => ({ id, type: 'checkout.session.completed', livemode: false } as any);
  async function paid(result: any) {
    const [row] = await db.select().from(stripeCheckouts).where(eq(stripeCheckouts.paymentId, result.deposit.paymentId));
    const session = remoteSessions.get(row!.sessionId!);
    Object.assign(session, { payment_status: 'paid', status: 'complete', payment_intent: 'pi_synthetic' });
    return { row: row!, session };
  }

  it('serializes independent buyers for the final unit through canonical HAIP inventory', async () => {
    const results = await Promise.allSettled([engine.book(propertyId, request()), engine.book(propertyId, request())]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.select().from(reservations).where(eq(reservations.propertyId, propertyId))).toHaveLength(1);
    expect(creations.size).toBe(1);
  });
  it('concurrent same-key retries recover one booking and one hosted session', async () => {
    const dto = request();
    const [a, b] = await Promise.all([engine.book(propertyId, dto), engine.book(propertyId, dto)]);
    expect(a.reservationId).toBe(b.reservationId); expect(a.deposit.nextAction).toEqual(b.deposit.nextAction);
    expect(creations.size).toBe(1);
    await expect(engine.book(propertyId, { ...dto, guestFirstName: 'Changed' })).rejects.toThrow('different request');
  });
  it('recovers a provider-created session after losing the creation response', async () => {
    const original = provider.checkout.sessions.create.getMockImplementation()!;
    provider.checkout.sessions.create.mockImplementationOnce(async (params, options) => { await original(params, options); throw new Error('lost response'); });
    const dto = request(); await expect(engine.book(propertyId, dto)).rejects.toThrow('lost response');
    expect(await db.select().from(reservations).where(eq(reservations.propertyId, propertyId))).toHaveLength(1);
    const replay = await engine.book(propertyId, dto);
    expect(replay.deposit.nextAction.url).toContain('checkout.stripe.com'); expect(creations.size).toBe(1);
  });
  it('commits duplicate signed-provider effects only once and retains failed outbox dispatch', async () => {
    const result = await engine.book(propertyId, request()); const { session } = await paid(result); const notification = event();
    webhook.dispatchPersisted.mockRejectedValue(new Error('delivery unavailable'));
    await Promise.all([events.process(notification, (tx, emit) => checkout.handleSession(session, tx, emit)),
      events.process(notification, (tx, emit) => checkout.handleSession(session, tx, emit))]);
    expect(await db.select().from(depositLedgerEntries).where(eq(depositLedgerEntries.propertyId, propertyId))).toHaveLength(1);
    const [stored] = await db.select().from(reservations).where(eq(reservations.id, result.reservationId)); expect(stored!.status).toBe('confirmed');
    const [receipt] = await db.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.eventId, notification.id));
    expect(receipt!.processedAt).not.toBeNull(); expect(receipt!.dispatchedAt).toBeNull();
    webhook.dispatchPersisted.mockResolvedValue(undefined); await events.retry();
    const [recovered] = await db.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.eventId, notification.id)); expect(recovered!.dispatchedAt).not.toBeNull();
  });
  it('rolls back the inbox and ledger after a crash; replay completes the same payment', async () => {
    const result = await engine.book(propertyId, request()); const { session } = await paid(result); const notification = event();
    await expect(events.process(notification, async (tx, emit) => { await checkout.handleSession(session, tx, emit); throw new Error('crash before commit'); })).rejects.toThrow();
    expect(await db.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.eventId, notification.id))).toHaveLength(0);
    expect(await db.select().from(depositLedgerEntries).where(eq(depositLedgerEntries.propertyId, propertyId))).toHaveLength(0);
    await events.process(notification, (tx, emit) => checkout.handleSession(session, tx, emit));
    expect(await db.select().from(depositLedgerEntries).where(eq(depositLedgerEntries.propertyId, propertyId))).toHaveLength(1);
  });
  it('does not confirm unpaid completed sessions, rejects mismatched money, and accepts async success', async () => {
    const result = await engine.book(propertyId, request()); const [row] = await db.select().from(stripeCheckouts).where(eq(stripeCheckouts.propertyId, propertyId));
    const session = remoteSessions.get(row!.sessionId!); session.status = 'complete';
    await events.process(event(), (tx, emit) => checkout.handleSession(session, tx, emit));
    let [stored] = await db.select().from(payments).where(eq(payments.id, result.deposit.paymentId)); expect(stored!.status).toBe('pending');
    session.amount_total = 9999;
    await expect(events.process(event(), (tx, emit) => checkout.handleSession(session, tx, emit))).rejects.toThrow('does not match');
    session.amount_total = 10000; await paid(result);
    await events.process(event(), (tx, emit) => checkout.handleSession(session, tx, emit));
    [stored] = await db.select().from(payments).where(eq(payments.id, result.deposit.paymentId)); expect(stored!.status).toBe('captured');
    // Current provider state wins over an older failure notification.
    await events.process(event(), (tx, emit) => checkout.handleSession({ ...session, payment_status: 'unpaid' }, tx, emit));
    expect(await db.select().from(depositLedgerEntries).where(eq(depositLedgerEntries.propertyId, propertyId))).toHaveLength(1);
  });
  it('expires unpaid holds, releases the final unit, and records late funds without reviving it', async () => {
    const result = await engine.book(propertyId, request());
    await db.update(reservations).set({ holdExpiresAt: new Date(Date.now() - 1000) }).where(and(eq(reservations.id, result.reservationId), eq(reservations.propertyId, propertyId)));
    await db.update(stripeCheckouts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(stripeCheckouts.propertyId, propertyId));
    await new BookingMaintenanceService(db, webhook as any, checkout).run();
    const second = await engine.book(propertyId, request());
    const { row, session } = await paid(result); await events.process(event(), (tx, emit) => checkout.handleSession(session, tx, emit));
    const [old] = await db.select().from(reservations).where(eq(reservations.id, result.reservationId)); expect(old!.status).toBe('cancelled');
    const [reconcile] = await db.select().from(stripeCheckouts).where(eq(stripeCheckouts.id, row.id)); expect(reconcile!.reconciliationRequired).toBe(true);
    expect(second.reservationId).not.toBe(old!.id);
  });
  it('blocks a manual receipt while hosted Checkout can still collect the same folio', async () => {
    const result = await engine.book(propertyId, request());
    const [receipt] = await db.select().from(payments).where(eq(payments.id, result.deposit.paymentId));
    await expect(payment.recordPayment({ propertyId, folioId: receipt!.folioId!, method: 'cash', amount: '100.00', currencyCode: 'GBP' })).rejects.toThrow('pending gateway');
  });
  it('applying a captured advance deposit does not credit the folio twice', async () => {
    const result = await engine.book(propertyId, request()); const { session } = await paid(result);
    await events.process(event(), (tx, emit) => checkout.handleSession(session, tx, emit));
    const [entry] = await db.select().from(depositLedgerEntries).where(eq(depositLedgerEntries.propertyId, propertyId));
    const [receipt] = await db.select().from(payments).where(eq(payments.id, result.deposit.paymentId));
    await deposits.applyDeposit(entry!.id, { propertyId, folioId: receipt!.folioId! });
    expect(await db.select().from(charges).where(eq(charges.propertyId, propertyId))).toHaveLength(0);
    const [stored] = await db.select().from(folios).where(eq(folios.id, receipt!.folioId!)); expect(stored!.totalPayments).toBe('100.00');
  });

  it('durably reserves a pending refund, rejects over-refunding, and settles once on provider success', async () => {
    const result = await engine.book(propertyId, request()); const { session } = await paid(result);
    await events.process(event(), (tx, emit) => checkout.handleSession(session, tx, emit));
    const id = result.deposit.paymentId;
    await expect(refunds.refund(id, propertyId, '60.00')).rejects.toThrow('require an idempotency key');
    const [a, b] = await Promise.all([refunds.refund(id, propertyId, '60.00', 'partial_one'), refunds.refund(id, propertyId, '60.00', 'partial_one')]);
    expect(a.id).toBe(b.id); expect(remoteRefunds.size).toBe(1); expect(a.status).toBe('pending');
    await expect(refunds.refund(id, propertyId, '50.00', 'partial_two')).rejects.toThrow('exceeds');
    const remote = remoteRefunds.get(a.gatewayTransactionId!); remote.status = 'succeeded';
    await Promise.all([events.process(event(), (tx, emit) => refunds.handleRefund(remote, tx, emit)), events.process(event(), (tx, emit) => refunds.handleRefund(remote, tx, emit))]);
    const [parent] = await db.select().from(payments).where(eq(payments.id, id));
    const [bill] = await db.select().from(folios).where(eq(folios.id, parent!.folioId!)); expect(bill!.totalPayments).toBe('40.00');
    const replay = await refunds.refund(id, propertyId, '60.00', 'partial_one'); expect(replay.id).toBe(a.id); expect(remoteRefunds.size).toBe(1);
    refundStatus = 'succeeded'; await refunds.refund(id, propertyId, '40.00', 'remaining');
    const [entry] = await db.select().from(depositLedgerEntries).where(eq(depositLedgerEntries.propertyId, propertyId)); expect(entry!.status).toBe('refunded');
  });
  it('recovers a lost refund response and ignores stale notifications after success', async () => {
    const result = await engine.book(propertyId, request()); const { session } = await paid(result);
    await events.process(event(), (tx, emit) => checkout.handleSession(session, tx, emit));
    refundStatus = 'succeeded'; const original = provider.refunds.create.getMockImplementation()!;
    provider.refunds.create.mockImplementationOnce(async (params, options) => { await original(params, options); throw new Error('lost refund response'); });
    await expect(refunds.refund(result.deposit.paymentId, propertyId, '100.00', 'lost')).rejects.toThrow('lost refund');
    const recovered = await refunds.refund(result.deposit.paymentId, propertyId, '100.00', 'lost'); expect(recovered.status).toBe('captured'); expect(remoteRefunds.size).toBe(1);
    const remote = remoteRefunds.get(recovered.gatewayTransactionId!);
    await events.process(event(), (tx, emit) => refunds.handleRefund({ ...remote, status: 'pending' }, tx, emit));
    const [stored] = await db.select().from(payments).where(eq(payments.id, recovered.id)); expect(stored!.status).toBe('captured');
  });
  it('failed refunds preserve funds and liability and permit a new logical attempt', async () => {
    const result = await engine.book(propertyId, request()); const { session } = await paid(result);
    await events.process(event(), (tx, emit) => checkout.handleSession(session, tx, emit));
    refundStatus = 'failed'; const failed = await refunds.refund(result.deposit.paymentId, propertyId, '100.00', 'failed'); expect(failed.status).toBe('failed');
    const [entry] = await db.select().from(depositLedgerEntries).where(eq(depositLedgerEntries.propertyId, propertyId)); expect(entry!.status).toBe('held');
    refundStatus = 'succeeded'; const next = await refunds.refund(result.deposit.paymentId, propertyId, '100.00', 'new'); expect(next.status).toBe('captured');
  });

  it('does not count pending dashboard refunds from a charge event, and credits verified success once', async () => {
    const result = await engine.book(propertyId, request()); const { session } = await paid(result);
    await events.process(event(), (tx, emit) => checkout.handleSession(session, tx, emit));
    const external = { id: 're_external', payment_intent: 'pi_synthetic', amount: 10000, currency: 'gbp', status: 'pending', metadata: {} };
    remoteRefunds.set(external.id, external);
    await events.process(event(), (tx, emit) => refunds.reconcileCharge({ payment_intent: 'pi_synthetic' } as any, tx, emit));
    let rows = await db.select().from(payments).where(eq(payments.propertyId, propertyId)); expect(rows).toHaveLength(1);
    external.status = 'succeeded';
    await events.process(event(), (tx, emit) => refunds.handleRefund(external as any, tx, emit));
    await events.process(event(), (tx, emit) => refunds.reconcileCharge({ payment_intent: 'pi_synthetic' } as any, tx, emit));
    rows = await db.select().from(payments).where(eq(payments.propertyId, propertyId)); expect(rows).toHaveLength(2);
    expect(rows.find(row => row.originalPaymentId)?.amount).toBe('-100.00');
  });

  it('reconciles a refund delivered before Checkout settlement without confirming a refunded stay', async () => {
    const result = await engine.book(propertyId, request()); const { row, session } = await paid(result);
    const external = { id: 're_before_capture', payment_intent: session.payment_intent, amount: 10000, currency: 'gbp', status: 'succeeded', metadata: {} };
    remoteRefunds.set(external.id, external);
    await events.process(event(), (tx, emit) => refunds.handleRefund(external as any, tx, emit)); // Not yet linked; settlement will recover it.
    await events.process(event(), (tx, emit) => checkout.handleSession(session, tx, emit));
    const [bill] = await db.select().from(payments).where(eq(payments.id, result.deposit.paymentId));
    const [balance] = await db.select().from(folios).where(eq(folios.id, bill!.folioId!)); expect(balance!.totalPayments).toBe('0.00');
    const [stored] = await db.select().from(reservations).where(eq(reservations.id, result.reservationId)); expect(stored!.status).toBe('pending');
    const [link] = await db.select().from(stripeCheckouts).where(eq(stripeCheckouts.id, row.id)); expect(link!.reconciliationRequired).toBe(true);
  });

  it('processes a signed refund through the registered controller and deduplicates delivery', async () => {
    const result = await engine.book(propertyId, request()); const { session } = await paid(result);
    await events.process(event(), (tx, emit) => checkout.handleSession(session, tx, emit));
    const claim = await refunds.refund(result.deposit.paymentId, propertyId);
    const remote = remoteRefunds.get(claim.gatewayTransactionId!); remote.status = 'succeeded';
    const controller = new StripeWebhookController(db, webhook as any, folio, config, undefined, events, checkout, invoices, refunds);
    const stripe = Reflect.get(controller, 'stripe');
    const payload = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'refund.updated', livemode: false, data: { object: remote } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_synthetic' });
    const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() });
    const a = response(), b = response();
    await Promise.all([controller.handleWebhook({ body: Buffer.from(payload), headers: { 'stripe-signature': signature } }, a),
      controller.handleWebhook({ body: Buffer.from(payload), headers: { 'stripe-signature': signature } }, b)]);
    expect(a.status).toHaveBeenCalledWith(200); expect(b.status).toHaveBeenCalledWith(200);
    const [stored] = await db.select().from(payments).where(eq(payments.id, claim.id)); expect(stored!.status).toBe('captured');
    const replay = await refunds.refund(result.deposit.paymentId, propertyId); expect(replay.id).toBe(claim.id); expect(remoteRefunds.size).toBe(1);
  });

  async function invoiceFixture() {
    const [guest] = await db.insert(guests).values({ firstName: 'Synthetic', lastName: 'Billing', email: 'billing@example.invalid' }).returning();
    // Link the guest to a reservation so cleanup and tenant ownership follow normal PMS semantics.
    const stay = await reservation.create({ propertyId, guestId: guest!.id, roomTypeId: typeId, ratePlanId: planId,
      arrivalDate: '2027-02-20', departureDate: '2027-02-21', totalAmount: '100.00', currencyCode: 'GBP', adults: 1, source: 'direct' } as any);
    const bill = await folio.createAutoFolio(stay);
    await folio.postCharge(bill.id, { propertyId, type: 'room', description: 'Synthetic outstanding accommodation', amount: '100.00', currencyCode: 'GBP', serviceDate: '2027-02-20', skipTaxCalculation: true });
    const [document] = await db.insert(fiscalDocuments).values({ propertyId, folioId: bill.id, documentType: 'invoice' }).returning();
    const remote = new Map<string, any>();
    const invoiceProvider = {
      accounts: provider.accounts,
      customers: { create: vi.fn(async () => ({ id: 'cus_synthetic' })) },
      invoices: {
        create: vi.fn(async (params: any) => { const value = { id: `in_${randomUUID()}`, ...params, status: 'draft', total: 0, livemode: false }; remote.set(value.id, value); return value; }),
        retrieve: vi.fn(async (id: string) => remote.get(id)),
        finalizeInvoice: vi.fn(async (id: string) => { const value = remote.get(id); value.status = 'open'; return value; }),
        sendInvoice: vi.fn(async (id: string) => ({ ...remote.get(id), hosted_invoice_url: 'https://invoice.stripe.com/synthetic', number: 'SYN-1' })),
        del: vi.fn(async (id: string) => ({ id, deleted: true })),
        voidInvoice: vi.fn(async (id: string) => { const value = remote.get(id); value.status = 'void'; return value; }),
      },
      invoiceItems: { create: vi.fn(async (params: any) => { remote.get(params.invoice).total = params.amount; return { id: 'ii_synthetic' }; }) },
      invoicePayments: { list: vi.fn(async () => ({ has_more: false, data: [{ status: 'paid', payment: { payment_intent: 'pi_invoice' } }] })) },
      paymentIntents: provider.paymentIntents,
    };
    Reflect.set(invoices, 'stripe', invoiceProvider);
    return { bill, document: document!, invoiceProvider, remote };
  }
  it('repeated invoice requests create one draft, send once, guard manual settlement, and credit once', async () => {
    const { bill, document, invoiceProvider, remote } = await invoiceFixture();
    const input = { propertyId, folioId: bill.id, documentId: document.id, dueDays: 14 };
    const [a, b] = await Promise.all([invoices.create(input), invoices.create(input)]); expect(a.id).toBe(b.id);
    expect(invoiceProvider.invoices.create).toHaveBeenCalledTimes(1);
    await Promise.all([invoices.send(a.id, propertyId), invoices.send(a.id, propertyId)]);
    expect(invoiceProvider.invoices.sendInvoice).toHaveBeenCalledTimes(1);
    await expect(payment.recordPayment({ propertyId, folioId: bill.id, method: 'cash', amount: '100.00', currencyCode: 'GBP' })).rejects.toThrow('Void the collectible');
    const current = remote.get(a.invoiceId!); Object.assign(current, { status: 'paid', amount_paid: 10000, amount_remaining: 0 });
    await Promise.all([events.process(event(), (tx, emit) => invoices.handleInvoice(current, tx, emit)), events.process(event(), (tx, emit) => invoices.handleInvoice(current, tx, emit))]);
    const [balance] = await db.select().from(folios).where(eq(folios.id, bill.id)); expect(balance!.balance).toBe('0.00'); expect(balance!.totalPayments).toBe('100.00');
  });
  it('voids the provider invoice and fiscal document before allowing manual collection', async () => {
    const { bill, document } = await invoiceFixture(); const draft = await invoices.create({ propertyId, folioId: bill.id, documentId: document.id, dueDays: 7 });
    await invoices.void(draft.id, propertyId); await invoices.void(draft.id, propertyId);
    await payment.recordPayment({ propertyId, folioId: bill.id, method: 'cash', amount: '100.00', currencyCode: 'GBP' });
    const [balance] = await db.select().from(folios).where(eq(folios.id, bill.id)); expect(balance!.balance).toBe('0.00');
    const [stored] = await db.select().from(fiscalDocuments).where(eq(fiscalDocuments.id, document.id)); expect(stored!.status).toBe('voided');
  });
  it('freezes invoiced charges through PMS services and the ledger, and releases them after void', async () => {
    const { bill, document, remote } = await invoiceFixture();
    const draft = await invoices.create({ propertyId, folioId: bill.id, documentId: document.id, dueDays: 7 });
    const [charge] = await db.select().from(charges).where(eq(charges.folioId, bill.id));
    await expect(folio.reverseCharge(bill.id, charge!.id, propertyId)).rejects.toThrow('Void the collectible');
    await expect(folio.postCharge(bill.id, { propertyId, type: 'adjustment', description: 'Synthetic correction', amount: '-10.00', currencyCode: 'GBP', serviceDate: '2027-02-20' })).rejects.toThrow('Void the collectible');
    await expect(db.update(charges).set({ amount: '90.00' }).where(eq(charges.id, charge!.id))).rejects.toMatchObject({ code: '23514' });
    await db.update(charges).set({ isLocked: true }).where(eq(charges.id, charge!.id));
    await db.update(charges).set({ isLocked: false }).where(eq(charges.id, charge!.id));
    const current = remote.get(draft.invoiceId!); current.status = 'uncollectible';
    await events.process(event(), (tx, emit) => invoices.handleInvoice(current, tx, emit));
    await expect(payment.recordPayment({ propertyId, folioId: bill.id, method: 'cash', amount: '100.00', currencyCode: 'GBP' })).rejects.toThrow('Void the collectible');
    await expect(folio.reverseCharge(bill.id, charge!.id, propertyId)).rejects.toThrow('Void the collectible');
    await invoices.void(draft.id, propertyId);
    await folio.reverseCharge(bill.id, charge!.id, propertyId);
    const [balance] = await db.select().from(folios).where(eq(folios.id, bill.id));
    expect(balance!.balance).toBe('0.00');
  });
  it('rejects cross-property invoice access and out-of-band paid invoices without inventing captured funds', async () => {
    const { bill, document, invoiceProvider, remote } = await invoiceFixture(); const draft = await invoices.create({ propertyId, folioId: bill.id, documentId: document.id, dueDays: 7 });
    await expect(invoices.read(draft.id, randomUUID())).rejects.toThrow('not found');
    expect((await invoices.list(bill.id, propertyId)).map((row: { id: string }) => row.id)).toEqual([draft.id]);
    expect(await invoices.list(bill.id, randomUUID())).toEqual([]);
    expect(await invoices.list(randomUUID(), propertyId)).toEqual([]);
    const current = remote.get(draft.invoiceId!); Object.assign(current, { status: 'paid', amount_paid: 10000, amount_remaining: 0 });
    invoiceProvider.invoicePayments.list.mockResolvedValueOnce({ has_more: false, data: [] });
    await expect(events.process(event(), (tx, emit) => invoices.handleInvoice(current, tx, emit))).rejects.toThrow('explicit reconciliation');
    const [stored] = await db.select().from(payments).where(eq(payments.id, draft.paymentId)); expect(stored!.status).toBe('pending');
  });
  it('rejects invalid signatures and returns a retryable error on a verified processing failure', async () => {
    const controller = new StripeWebhookController(db, webhook as any, folio, config, undefined, events, checkout, invoices);
    const stripe = Reflect.get(controller, 'stripe');
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_not_correlated', metadata: { haip_property_id: propertyId, haip_checkout_id: randomUUID() } } } });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await expect(controller.handleWebhook({ headers: { 'stripe-signature': 'invalid' }, body: Buffer.from(body) }, res)).rejects.toMatchObject({ status: 400 });
    const signature = stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_synthetic' });
    await expect(controller.handleWebhook({ headers: { 'stripe-signature': signature }, body: Buffer.from(body) }, res)).rejects.toMatchObject({ status: 503 });
    expect(res.status).not.toHaveBeenCalledWith(200);
  });
});

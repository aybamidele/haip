import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@telivityhaip/database';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingMaintenanceService } from './booking-maintenance.service';
import type { TaxService } from '../tax/tax.service';
import { ConfigService } from '@nestjs/config';
import { PaymentService } from '../payment/payment.service';
import { FolioService } from '../folio/folio.service';
import type { PaymentGateway } from '../payment/interfaces/payment-gateway.interface';
import { RedsysCredentialsService } from '../payment/redsys-credentials.service';
import { AvailabilityService } from '../reservation/availability.service';
import type { WebhookService } from '../webhook/webhook.service';

const url = process.env['HOLD_TEST_DATABASE_URL'];
describe.skipIf(!url)('unpaid hold maintenance on PostgreSQL', () => {
  const client = postgres(url ?? 'postgresql://localhost/unavailable', { max: 6 });
  const db = drizzle(client, { schema });
  const webhook = { emit: vi.fn().mockResolvedValue(undefined) };
  let propertyId: string, roomTypeId: string, ratePlanId: string, guestId: string, bookingId: string, reservationId: string, folioId: string;
  const maintenance = () => new BookingMaintenanceService(db, webhook as unknown as WebhookService);
  beforeEach(async () => {
    vi.clearAllMocks();
    propertyId = randomUUID(); roomTypeId = randomUUID(); ratePlanId = randomUUID(); guestId = randomUUID(); bookingId = randomUUID(); reservationId = randomUUID(); folioId = randomUUID();
    await db.insert(schema.properties).values({ id: propertyId, name: 'Synthetic hold regression', code: propertyId.slice(0, 20), countryCode: 'GB', timezone: 'UTC', currencyCode: 'GBP', totalRooms: 1 });
    await db.insert(schema.roomTypes).values({ id: roomTypeId, propertyId, name: 'Synthetic unit', code: 'UNIT', maxOccupancy: 2, defaultOccupancy: 2 });
    await db.insert(schema.rooms).values({ propertyId, roomTypeId, number: '1', status: 'guest_ready' });
    await db.insert(schema.ratePlans).values({ id: ratePlanId, propertyId, roomTypeId, name: 'Synthetic rate', code: 'TEST', type: 'bar', baseAmount: '100', currencyCode: 'GBP' });
    await db.insert(schema.guests).values({ id: guestId, firstName: 'Synthetic', lastName: 'Hold' });
    await db.insert(schema.bookings).values({ id: bookingId, propertyId, guestId, confirmationNumber: bookingId, source: 'direct' });
    await db.insert(schema.reservations).values({ id: reservationId, propertyId, bookingId, guestId, roomTypeId, ratePlanId, arrivalDate: '2027-11-01', departureDate: '2027-11-02', nights: 1, totalAmount: '100', currencyCode: 'GBP', status: 'pending', holdExpiresAt: new Date(Date.now() - 1000) });
    await db.insert(schema.folios).values({ id: folioId, propertyId, reservationId, folioNumber: folioId, guestId, currencyCode: 'GBP' });
  });
  afterEach(async () => {
    await db.delete(schema.payments).where(eq(schema.payments.propertyId, propertyId));
    await db.delete(schema.folios).where(eq(schema.folios.propertyId, propertyId));
    await db.delete(schema.reservations).where(eq(schema.reservations.propertyId, propertyId));
    await db.delete(schema.bookings).where(eq(schema.bookings.propertyId, propertyId));
    await db.delete(schema.rooms).where(eq(schema.rooms.propertyId, propertyId));
    await db.delete(schema.ratePlans).where(eq(schema.ratePlans.propertyId, propertyId));
    await db.delete(schema.roomTypes).where(eq(schema.roomTypes.propertyId, propertyId));
    await db.delete(schema.guests).where(eq(schema.guests.id, guestId));
    await db.delete(schema.properties).where(eq(schema.properties.id, propertyId));
  });
  afterAll(() => client.end());
  async function row() { return (await db.select().from(schema.reservations).where(eq(schema.reservations.id, reservationId)))[0]!; }
  async function receipt(status: 'captured' | 'settled' | 'authorized' | 'failed' = 'captured', amount = '100') {
    await db.insert(schema.payments).values({ propertyId, folioId, amount, currencyCode: 'GBP', method: 'bank_transfer', status });
  }
  it('releases actual inventory once after expiry, including two independent maintainers', async () => {
    const availability = new AvailabilityService(db);
    expect((await availability.searchAvailability(propertyId, '2027-11-01', '2027-11-02', roomTypeId))[0].available).toBe(0);
    await Promise.all([maintenance().run(), maintenance().run()]);
    expect((await row()).status).toBe('cancelled'); expect(webhook.emit).toHaveBeenCalledOnce();
    expect((await availability.searchAvailability(propertyId, '2027-11-01', '2027-11-02', roomTypeId))[0].available).toBe(1);
    await maintenance().run(); expect(webhook.emit).toHaveBeenCalledOnce();
  });
  it.each(['captured', 'settled'] as const)('preserves an expired pending hold with %s money', async status => {
    await receipt(status); await maintenance().run(); expect((await row()).status).toBe('pending');
  });
  it.each(['authorized', 'failed'] as const)('does not mistake %s for received money', async status => {
    await receipt(status); await maintenance().run(); expect((await row()).status).toBe('cancelled');
  });
  it('does not let zero or negative receipts protect unpaid inventory', async () => {
    await receipt('captured', '0'); await receipt('captured', '-100'); await maintenance().run(); expect((await row()).status).toBe('cancelled');
  });
  it('retains future holds and permanent/confirmed stays', async () => {
    await db.update(schema.reservations).set({ holdExpiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.reservations.id, reservationId));
    await maintenance().run(); expect((await row()).status).toBe('pending');
    await db.update(schema.reservations).set({ holdExpiresAt: null }).where(eq(schema.reservations.id, reservationId));
    await maintenance().run(); expect((await row()).status).toBe('pending');
    await db.update(schema.reservations).set({ status: 'confirmed', holdExpiresAt: new Date(0) }).where(eq(schema.reservations.id, reservationId));
    await maintenance().run(); expect((await row()).status).toBe('confirmed');
  });
  it('rechecks committed money after a receipt writer owns the reservation lock', async () => {
    let locked!: () => void, release!: () => void;
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writer = db.transaction(async tx => {
      await tx.select().from(schema.reservations).where(eq(schema.reservations.id, reservationId)).for('update');
      await tx.insert(schema.payments).values({ propertyId, folioId, amount: '100', currencyCode: 'GBP', method: 'bank_transfer', status: 'captured' });
      locked(); await gate;
    });
    await lockReady;
    const sweep = maintenance().run();
    try { await new Promise(resolve => setTimeout(resolve, 100)); }
    finally { release(); }
    await writer; await sweep;
    expect((await row()).status).toBe('pending');
  });
  it('records an actual late manual receipt after the expiry lock wins without reviving inventory', async () => {
    const folio = new FolioService(db, webhook as unknown as WebhookService, {} as TaxService);
    const payment = new PaymentService(db, folio, {} as PaymentGateway, webhook as unknown as WebhookService, new ConfigService(), {} as RedsysCredentialsService);
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const expiry = db.transaction(async tx => {
      await tx.select().from(schema.reservations).where(eq(schema.reservations.id, reservationId)).for('update');
      await tx.update(schema.reservations).set({ status: 'cancelled' }).where(eq(schema.reservations.id, reservationId));
      locked(); await gate;
    });
    await ready; let recorded = false;
    const recording = payment.recordPayment({ propertyId, folioId, amount: '100', currencyCode: 'GBP', method: 'bank_transfer' }).then(result => { recorded = true; return result; });
    try { await new Promise(resolve => setTimeout(resolve, 100)); expect(recorded).toBe(false); }
    finally { release(); }
    await expiry; const received = await recording;
    expect(received.status).toBe('captured'); expect((await row()).status).toBe('cancelled');
    expect((await new AvailabilityService(db).searchAvailability(propertyId, '2027-11-01', '2027-11-02', roomTypeId))[0].available).toBe(1);
  });
  it('keeps a hold with a manual receipt recorded through PaymentService', async () => {
    const folio = new FolioService(db, webhook as unknown as WebhookService, {} as TaxService);
    const payment = new PaymentService(db, folio, {} as PaymentGateway, webhook as unknown as WebhookService, new ConfigService(), {} as RedsysCredentialsService);
    await payment.recordPayment({ propertyId, folioId, amount: '100', currencyCode: 'GBP', method: 'bank_transfer' });
    await maintenance().run(); expect((await row()).status).toBe('pending');
  });

});

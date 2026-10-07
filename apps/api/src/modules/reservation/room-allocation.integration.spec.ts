import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@telivityhaip/database';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvailabilityService } from './availability.service';
import { ReservationService } from './reservation.service';
import { ReservationPartyService } from './reservation-party.service';
import { lockAllocationSnapshot } from './room-allocation';
import type { FolioService } from '../folio/folio.service';
import type { RoomStatusService } from '../room/room-status.service';
import type { PaymentService } from '../payment/payment.service';
import type { WebhookService } from '../webhook/webhook.service';
import type { AncillaryService } from '../ancillary/ancillary.service';
import type { PolicyService } from '../policy/policy.service';
import type { DepositSettlementService } from '../accounting/deposit-settlement.service';
import type { RatePlanService } from '../rate-plan/rate-plan.service';

const databaseUrl = process.env['ROOM_ALLOCATION_TEST_DATABASE_URL'];
describe.skipIf(!databaseUrl)('physical room allocation on PostgreSQL', () => {
  // Explicit opt-in: only a disposable, migrated regression database.
  const client = postgres(databaseUrl ?? 'postgresql://localhost/unavailable', { max: 10 });
  const db = drizzle(client, { schema });
  let propertyId: string, roomTypeId: string, ratePlanId: string, bookingId: string;
  let unitA: string, unitB: string, service: ReservationService;
  const guestIds: string[] = [];
  const webhook = { emit: vi.fn().mockResolvedValue(undefined) };
  const roomStatus = { markOccupied: vi.fn(), markVacantDirty: vi.fn() };
  const folio = { createAutoFolio: vi.fn().mockResolvedValue({ id: 'synthetic-folio' }), postCharge: vi.fn() };
  beforeEach(async () => {
    vi.clearAllMocks();
    propertyId = randomUUID(); roomTypeId = randomUUID(); ratePlanId = randomUUID(); bookingId = randomUUID();
    unitA = randomUUID(); unitB = randomUUID();
    await db.insert(schema.properties).values({ id: propertyId, name: 'Synthetic allocation test', code: propertyId.slice(0, 20), countryCode: 'GB', timezone: 'UTC', currencyCode: 'GBP', totalRooms: 2 });
    await db.insert(schema.roomTypes).values({ id: roomTypeId, propertyId, name: 'Synthetic type', code: 'UNIT', maxOccupancy: 4, defaultOccupancy: 2 });
    await db.insert(schema.rooms).values([unitA, unitB].map((id, index) => ({ id, propertyId, roomTypeId, number: String(index + 1), status: 'guest_ready' as const })));
    await db.insert(schema.ratePlans).values({ id: ratePlanId, propertyId, roomTypeId, name: 'Synthetic rate', code: 'TEST', type: 'bar', baseAmount: '100', currencyCode: 'GBP' });
    const guestId = await guest();
    await db.insert(schema.bookings).values({ id: bookingId, propertyId, guestId, confirmationNumber: bookingId, source: 'direct' });
    service = new ReservationService(db, new AvailabilityService(db), folio as unknown as FolioService,
      roomStatus as unknown as RoomStatusService, {} as PaymentService, webhook as unknown as WebhookService,
      {} as AncillaryService, {} as PolicyService, {} as DepositSettlementService,
      { assertSellable: vi.fn() } as unknown as RatePlanService);
  });
  afterEach(async () => {
    await db.delete(schema.reservationGuests).where(eq(schema.reservationGuests.propertyId, propertyId));
    await db.delete(schema.icalBlocks).where(eq(schema.icalBlocks.propertyId, propertyId));
    await db.delete(schema.icalFeeds).where(eq(schema.icalFeeds.propertyId, propertyId));
    await db.delete(schema.reservations).where(eq(schema.reservations.propertyId, propertyId));
    await db.delete(schema.bookings).where(eq(schema.bookings.propertyId, propertyId));
    await db.delete(schema.ratePlans).where(eq(schema.ratePlans.propertyId, propertyId));
    await db.delete(schema.rooms).where(eq(schema.rooms.propertyId, propertyId));
    for (const id of guestIds.splice(0)) await db.delete(schema.guests).where(eq(schema.guests.id, id));
    await db.delete(schema.roomTypes).where(eq(schema.roomTypes.propertyId, propertyId));
    await db.delete(schema.properties).where(eq(schema.properties.id, propertyId));
  });
  afterAll(async () => { await client.end(); });
  async function guest() {
    const id = randomUUID(); guestIds.push(id);
    await db.insert(schema.guests).values({ id, firstName: 'Synthetic', lastName: 'Allocation' });
    return id;
  }
  async function reservation(values: Partial<typeof schema.reservations.$inferInsert> = {}) {
    const [row] = await db.insert(schema.reservations).values({ propertyId, bookingId, guestId: await guest(), roomTypeId,
      ratePlanId, arrivalDate: '2027-11-01', departureDate: '2027-11-04', nights: 3,
      totalAmount: '300', currencyCode: 'GBP', status: 'confirmed', ...values }).returning();
    return row!;
  }
  async function block(roomId = unitA, values: { isActive?: boolean; direction?: 'import' | 'export'; startDate?: string; endDate?: string } = {}) {
    const [feed] = await db.insert(schema.icalFeeds).values({ propertyId, roomTypeId, roomId, name: 'Synthetic source', direction: values.direction ?? 'import', isActive: values.isActive ?? true, lastSyncStatus: 'failed' }).returning();
    await db.insert(schema.icalBlocks).values({ propertyId, roomTypeId, feedId: feed!.id, externalUid: randomUUID(), sourceChecksum: 'synthetic-checksum', startDate: values.startDate ?? '2027-11-02', endDate: values.endDate ?? '2027-11-03' });
  }
  it('returns the joined booking source on scoped reservation reads', async () => {
    const own = await reservation();
    let listed = await service.list({ propertyId, guestId: own.guestId });
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].source).toBe('direct');
    expect(listed.data[0].confirmationNumber).toBe(bookingId);
    await db.update(schema.bookings).set({ source: 'ota' }).where(eq(schema.bookings.id, bookingId));
    listed = await service.list({ propertyId, guestId: own.guestId });
    expect(listed.data[0].source).toBe('ota');
    expect((await service.list({ propertyId: randomUUID(), guestId: own.guestId })).data).toEqual([]);
  });
  it('admits exactly one of two simultaneous overlapping assignments to the same unit', async () => {
    const a = await reservation(), b = await reservation();
    const results = await Promise.allSettled([service.assignRoom(a.id, propertyId, { roomId: unitA }), service.assignRoom(b.id, propertyId, { roomId: unitA })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find(r => r.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason).toBeInstanceOf(ConflictException);
  });
  it('rejects a mapped calendar block even when the last download failed', async () => {
    const stay = await reservation(); await block();
    await expect(service.assignRoom(stay.id, propertyId, { roomId: unitA })).rejects.toBeInstanceOf(ConflictException);
    expect((await db.select().from(schema.reservations).where(eq(schema.reservations.id, stay.id)))[0]?.status).toBe('confirmed');
  });
  it('rejects a conflicting move without changing assignment or running side effects', async () => {
    const stay = await reservation({ status: 'assigned', roomId: unitA });
    await reservation({ status: 'assigned', roomId: unitB });
    await expect(service.moveRoom(stay.id, propertyId, { roomId: unitB })).rejects.toBeInstanceOf(ConflictException);
    expect((await db.select().from(schema.reservations).where(eq(schema.reservations.id, stay.id)))[0]?.roomId).toBe(unitA);
    expect(roomStatus.markOccupied).not.toHaveBeenCalled(); expect(webhook.emit).not.toHaveBeenCalled();
  });
  it.each(['pending', 'confirmed', 'assigned', 'checked_in', 'stayover', 'due_out'] as const)('rejects an overlapping %s reservation on the selected physical unit', async (status) => {
    await reservation({ roomId: unitA, status }); const stay = await reservation();
    await expect(service.assignRoom(stay.id, propertyId, { roomId: unitA })).rejects.toBeInstanceOf(ConflictException);
  });
  it.each(['cancelled', 'no_show', 'checked_out'] as const)('allows a unit after its overlapping reservation is %s', async (status) => {
    await reservation({ roomId: unitA, status }); const stay = await reservation();
    expect((await service.assignRoom(stay.id, propertyId, { roomId: unitA })).status).toBe('assigned');
  });
  it('allows consecutive stays sharing the checkout boundary', async () => {
    await reservation({ roomId: unitA, status: 'assigned' });
    const next = await reservation({ arrivalDate: '2027-11-04', departureDate: '2027-11-06', nights: 2 });
    expect((await service.assignRoom(next.id, propertyId, { roomId: unitA })).roomId).toBe(unitA);
  });
  it('leaves another physical unit assignable when a mapped import occupies the first', async () => {
    await block(); const stay = await reservation();
    expect((await service.assignRoom(stay.id, propertyId, { roomId: unitB })).roomId).toBe(unitB);
  });
  it.each([{ isActive: false }, { direction: 'export' as const }, { endDate: '2027-11-01', startDate: '2027-10-30' }])('ignores inactive/export/adjacent imported blocks: %j', async (values) => {
    await block(unitA, values); const stay = await reservation();
    expect((await service.assignRoom(stay.id, propertyId, { roomId: unitA })).roomId).toBe(unitA);
  });
  it('prevents assigning an inactive physical unit or another property reservation', async () => {
    const stay = await reservation();
    await db.update(schema.rooms).set({ isActive: false }).where(eq(schema.rooms.id, unitA));
    await expect(service.assignRoom(stay.id, propertyId, { roomId: unitA })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.assignRoom(stay.id, randomUUID(), { roomId: unitB })).rejects.toBeInstanceOf(NotFoundException);
  });
  it('serialises an assignment and move competing for the same free unit', async () => {
    const moving = await reservation({ roomId: unitA, status: 'assigned' }), unassigned = await reservation();
    const results = await Promise.allSettled([service.moveRoom(moving.id, propertyId, { roomId: unitB }), service.assignRoom(unassigned.id, propertyId, { roomId: unitB })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
  it('check-in excludes its own assignment but rejects another assigned stay before side effects', async () => {
    const valid = await reservation({ roomId: unitA, status: 'assigned' });
    expect((await service.checkIn(valid.id, propertyId, { registrationSigned: true })).reservation.status).toBe('checked_in');
    vi.clearAllMocks(); const conflict = await reservation({ roomId: unitA, status: 'assigned' });
    await expect(service.checkIn(conflict.id, propertyId, { registrationSigned: true })).rejects.toBeInstanceOf(ConflictException);
    expect(folio.createAutoFolio).not.toHaveBeenCalled(); expect(roomStatus.markOccupied).not.toHaveBeenCalled(); expect(webhook.emit).not.toHaveBeenCalled();
  });
  it('check-in cannot override its room onto a mapped busy unit', async () => {
    const stay = await reservation({ roomId: unitB, status: 'assigned' }); await block();
    await expect(service.checkIn(stay.id, propertyId, { roomId: unitA, registrationSigned: true })).rejects.toBeInstanceOf(ConflictException);
    expect(folio.createAutoFolio).not.toHaveBeenCalled();
  });
  it('date edits reject physical conflicts and roll back instead of using free pooled capacity', async () => {
    const stay = await reservation({ roomId: unitA, status: 'assigned' });
    await reservation({ roomId: unitA, status: 'assigned', arrivalDate: '2027-11-04', departureDate: '2027-11-06', nights: 2 });
    await expect(service.modify(stay.id, propertyId, { departureDate: '2027-11-05' })).rejects.toBeInstanceOf(ConflictException);
    expect((await db.select().from(schema.reservations).where(eq(schema.reservations.id, stay.id)))[0]?.departureDate).toBe('2027-11-04');
    expect(webhook.emit).not.toHaveBeenCalled();
  });
  it('allows non-conflicting date edits and rejects a mapped block on an extended stay', async () => {
    const stay = await reservation({ roomId: unitA, status: 'assigned', departureDate: '2027-11-02', nights: 1 });
    expect((await service.modify(stay.id, propertyId, { arrivalDate: '2027-10-31' })).reservation.arrivalDate).toBe('2027-10-31');
    await block(); await expect(service.modify(stay.id, propertyId, { departureDate: '2027-11-04' })).rejects.toBeInstanceOf(ConflictException);
  });
  it('accepted stay amendments cannot extend an assigned unit into another stay', async () => {
    const pricing = (days: string[]): schema.AcceptedPricingSnapshot => ({ version: 1, source: 'submitted', currencyCode: 'GBP',
      grandTotal: String(days.length * 100)+'.00', roomTotal: String(days.length * 100)+'.00', taxTotal: '0.00',
      nights: days.map(date => ({ date, roomAmount: '100.00', taxAmount: '0.00' })), services: [],
      servicesTotal: '0.00', servicesTaxTotal: '0.00', customReason: null, adjustment: null });
    const original = pricing(['2027-11-01', '2027-11-02', '2027-11-03']);
    const extended = pricing(['2027-11-01', '2027-11-02', '2027-11-03', '2027-11-04']);
    const stay = await reservation({ roomId: unitA, status: 'assigned', acceptedPricingSnapshot: original });
    await reservation({ roomId: unitA, status: 'assigned', arrivalDate: '2027-11-04', departureDate: '2027-11-06', nights: 2 });
    await expect(db.transaction(async tx => {
      const locked = await lockAllocationSnapshot(tx, stay);
      return service.modifyAcceptedStay(locked, propertyId, { arrivalDate: stay.arrivalDate, departureDate: '2027-11-05', totalAmount: '400.00' }, extended, tx);
    })).rejects.toBeInstanceOf(ConflictException);
    expect((await db.select().from(schema.reservations).where(eq(schema.reservations.id, stay.id)))[0]?.acceptedPricingSnapshot).toEqual(original);
  });
  it('moves also reject mapped busy dates without emitting a successful move', async () => {
    const stay = await reservation({ roomId: unitB, status: 'assigned' }); await block();
    await expect(service.moveRoom(stay.id, propertyId, { roomId: unitA })).rejects.toBeInstanceOf(ConflictException);
    expect(webhook.emit).not.toHaveBeenCalled();
  });
  it('rejects stale allocation snapshots before any inventory write', async () => {
    const stay = await reservation();
    await db.update(schema.reservations).set({ departureDate: '2027-11-05' }).where(eq(schema.reservations.id, stay.id));
    await expect(db.transaction(tx => lockAllocationSnapshot(tx, stay))).rejects.toBeInstanceOf(ConflictException);
  });
  it('group check-in cannot bypass concurrent physical-unit ownership', async () => {
    await db.update(schema.properties).set({ guestRegistrationRequired: false }).where(eq(schema.properties.id, propertyId));
    const first = await reservation(), second = await reservation();
    const result = await service.groupCheckIn(propertyId, { reservations: [first, second].map(stay => ({ reservationId: stay.id, roomId: unitA, skipDepositAuth: true })) });
    expect(result.succeeded).toBe(1); expect(result.failed).toBe(1);
    expect(folio.createAutoFolio).toHaveBeenCalledOnce(); expect(roomStatus.markOccupied).toHaveBeenCalledOnce();
  });
  async function splitFixture() {
    const source = await reservation({ roomId: unitA, status: 'assigned', adults: 2 });
    const accompanyingId = await guest();
    await db.insert(schema.reservationGuests).values([{ propertyId, reservationId: source.id, guestId: source.guestId, role: 'primary' },
      { propertyId, reservationId: source.id, guestId: accompanyingId, role: 'accompanying' }]);
    const party = new ReservationPartyService(db, webhook as unknown as WebhookService, roomStatus as unknown as RoomStatusService,
      { assertSellable: vi.fn() } as unknown as RatePlanService, new AvailabilityService(db));
    return { source, accompanyingId, party };
  }
  it('splitting guests cannot assign the source unit to another overlapping reservation', async () => {
    const { source, accompanyingId, party } = await splitFixture();
    await expect(party.split(source.id, propertyId, { guestIds: [accompanyingId], roomTypeId, ratePlanId, roomId: unitA, totalAmount: '100' })).rejects.toBeInstanceOf(ConflictException);
    expect(await db.select().from(schema.reservations).where(eq(schema.reservations.propertyId, propertyId))).toHaveLength(1);
  });
  it('splitting guests respects pooled inventory and permits a different free unit', async () => {
    const { source, accompanyingId, party } = await splitFixture(); await block(unitB);
    const input = { guestIds: [accompanyingId], roomTypeId, ratePlanId, roomId: unitB, totalAmount: '100' };
    await expect(party.split(source.id, propertyId, input)).rejects.toBeInstanceOf(BadRequestException);
    await db.update(schema.icalFeeds).set({ isActive: false }).where(eq(schema.icalFeeds.propertyId, propertyId));
    expect((await party.split(source.id, propertyId, input)).reservation.roomId).toBe(unitB);
  });
});

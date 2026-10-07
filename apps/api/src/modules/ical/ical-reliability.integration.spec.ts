import { ConfigService } from '@nestjs/config';
import { ConflictException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@telivityhaip/database';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IcalService } from './ical.service';
import { AvailabilityService } from '../reservation/availability.service';
import { parseIcsBusyBlocks } from './ical.util';
import { IcalPollingService } from './ical-polling.service';

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), writeFileSync: vi.fn(), renameSync: vi.fn() }));
const databaseUrl = process.env['ICAL_TEST_DATABASE_URL'];
const calendar = (extra = '') => `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:stable-uid\nDTSTART;VALUE=DATE:20271101\nDTEND;VALUE=DATE:20271104\n${extra}\nEND:VEVENT\nEND:VCALENDAR`;

function downloader(service: IcalService) {
  return vi.spyOn(service as unknown as { fetchIcs(url: string): Promise<string> }, 'fetchIcs');
}

describe.skipIf(!databaseUrl)('iCal reliability on PostgreSQL', () => {
  // The opt-in URL must target a disposable, migrated regression database.
  const client = postgres(databaseUrl ?? 'postgresql://localhost/unavailable', { max: 10 });
  const db = drizzle(client, { schema });
  const config = new ConfigService({ ICAL_SIGNING_SECRET: 'synthetic-calendar-secret', PUBLIC_API_BASE_URL: 'https://pms.example.test/api/v1' });
  let service: IcalService;
  let propertyId: string;
  let roomTypeId: string;
  let feedId: string;
  const guestIds: string[] = [];
  beforeEach(async () => {
    propertyId = randomUUID(); roomTypeId = randomUUID();
    await db.insert(schema.properties).values({ id: propertyId, name: 'Synthetic calendar test', code: propertyId.slice(0, 20), countryCode: 'GB', timezone: 'Europe/London', currencyCode: 'GBP', totalRooms: 1 });
    await db.insert(schema.roomTypes).values({ id: roomTypeId, propertyId, name: 'Synthetic unit', code: 'UNIT', maxOccupancy: 2, defaultOccupancy: 2 });
    service = new IcalService(db, config);
    const created = await service.create({ propertyId, roomTypeId, direction: 'import', name: 'Synthetic feed', sourceUrl: 'https://calendar.example.test/?token=private-token' });
    feedId = created.feed.id;
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await db.delete(schema.auditLogs).where(eq(schema.auditLogs.propertyId, propertyId));
    await db.delete(schema.icalBlocks).where(eq(schema.icalBlocks.propertyId, propertyId));
    await db.delete(schema.icalFeeds).where(eq(schema.icalFeeds.propertyId, propertyId));
    await db.delete(schema.reservations).where(eq(schema.reservations.propertyId, propertyId));
    await db.delete(schema.bookings).where(eq(schema.bookings.propertyId, propertyId));
    await db.delete(schema.ratePlans).where(eq(schema.ratePlans.propertyId, propertyId));
    await db.delete(schema.rooms).where(eq(schema.rooms.propertyId, propertyId));
    for (const id of guestIds.splice(0)) await db.delete(schema.guests).where(eq(schema.guests.id, id));
    await db.delete(schema.roomTypes).where(eq(schema.roomTypes.propertyId, propertyId));
    await db.delete(schema.properties).where(eq(schema.properties.id, propertyId));
    vi.restoreAllMocks(); vi.mocked(writeFileSync).mockClear();
  });
  afterAll(async () => { await client.end(); });
  const feed = async () => (await db.select().from(schema.icalFeeds).where(and(eq(schema.icalFeeds.id, feedId), eq(schema.icalFeeds.propertyId, propertyId))))[0]!;
  const blocks = () => db.select().from(schema.icalBlocks).where(and(eq(schema.icalBlocks.feedId, feedId), eq(schema.icalBlocks.propertyId, propertyId)));
  const health = () => JSON.parse(String(vi.mocked(writeFileSync).mock.calls.at(-1)?.[1])) as { status: string; failedFeeds: number; staleFeeds: number };

  it('polls new imports automatically and skips fresh snapshots instead of importing again', async () => {
    const fetch = downloader(service).mockResolvedValue(calendar());
    const worker = new IcalPollingService(db, config, service);
    await worker.run();
    expect(fetch).toHaveBeenCalledOnce();
    const snapshot = await blocks(); expect(snapshot).toHaveLength(1);
    expect((await feed()).lastSuccessfulSyncAt).toBeInstanceOf(Date);
    expect((await feed()).lastSyncStatus).toBe('success');
    await worker.run();
    expect(fetch).toHaveBeenCalledOnce(); expect(await blocks()).toEqual(snapshot);
    expect(health().status).toBe('ok');
  });
  it('retains the last good blocks and success timestamp through failures, then releases cancelled events', async () => {
    const fetch = downloader(service).mockResolvedValue(calendar());
    await service.syncImportFeed(feedId, propertyId);
    const snapshot = await blocks(); const good = (await feed()).lastSuccessfulSyncAt;
    fetch.mockResolvedValue('<html>Provider unavailable</html>');
    await expect(service.syncImportFeed(feedId, propertyId)).rejects.toThrow(/Invalid or unsupported calendar/);
    expect(await blocks()).toEqual(snapshot);
    expect((await feed()).lastSuccessfulSyncAt).toEqual(good);
    expect((await feed()).consecutiveSyncFailures).toBe(1);
    await expect(service.syncImportFeed(feedId, propertyId)).rejects.toThrow();
    expect((await feed()).consecutiveSyncFailures).toBe(2);
    fetch.mockResolvedValue(calendar('STATUS:CANCELLED'));
    await service.update(feedId, propertyId, { sourceUrl: 'https://calendar.example.test/cancelled.ics' });
    expect((await feed()).lastSyncAt).toBeNull();
    expect(await blocks()).toEqual(snapshot);
    expect((await feed()).lastSuccessfulSyncAt).toEqual(good);
    await new IcalPollingService(db, config, service).run();
    expect(await blocks()).toEqual([]); expect((await feed()).consecutiveSyncFailures).toBe(0);
    expect((await feed()).lastSyncError).toBeNull();
  });
  it('serializes independent sync callers and rejects an overlapping manual attempt', async () => {
    let release!: (text: string) => void;
    const fetch = downloader(service).mockImplementation(() => new Promise<string>((resolve) => { release = resolve; }));
    const first = service.syncImportFeed(feedId, propertyId);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    try {
      const second = new IcalService(db, config);
      const secondFetch = downloader(second).mockResolvedValue(calendar().replace('stable-uid', 'newer-uid'));
      await expect(second.syncImportFeed(feedId, propertyId)).rejects.toBeInstanceOf(ConflictException);
      expect(secondFetch).not.toHaveBeenCalled();
    } finally { release(calendar()); await first; }
    expect((await blocks())[0]?.externalUid).toBe('stable-uid');
  });
  it('skips overlapping scheduled attempts without marking the feed failed', async () => {
    let release!: (text: string) => void;
    const fetch = downloader(service).mockImplementation(() => new Promise<string>((resolve) => { release = resolve; }));
    const first = service.syncImportFeed(feedId, propertyId);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    try {
      const second = new IcalService(db, config);
      expect(await second.syncImportFeed(feedId, propertyId, new Date())).toEqual({ skipped: true });
    } finally { release(calendar()); await first; }
    expect((await feed()).lastSyncStatus).toBe('success');
  });
  it('checks explicit property scope before fetching or changing any snapshot', async () => {
    const fetch = downloader(service).mockResolvedValue(calendar());
    await expect(service.syncImportFeed(feedId, randomUUID())).rejects.toThrow(/not found/);
    expect(fetch).not.toHaveBeenCalled(); expect(await blocks()).toEqual([]);
  });
  it('continues other feeds after a failure and never persists or logs the underlying private error', async () => {
    await service.create({ propertyId, roomTypeId, direction: 'import', name: 'Healthy feed', sourceUrl: 'https://calendar.example.test/good.ics' });
    downloader(service).mockImplementation(async (url) => {
      if (url.includes('private-token')) throw new Error('secret feed URL, private-token, guest@example.test');
      return calendar();
    });
    await new IcalPollingService(db, config, service).run();
    expect((await feed()).lastSyncStatus).toBe('failed');
    expect((await feed()).lastSyncError).toBe('Invalid or unsupported calendar');
    expect(health()).toMatchObject({ status: 'degraded', failedFeeds: 1 });
    expect(JSON.stringify(vi.mocked(Logger.prototype.warn).mock.calls)).not.toMatch(/private-token|guest@example/);
    const healthy = await db.select().from(schema.icalFeeds).where(and(eq(schema.icalFeeds.propertyId, propertyId), eq(schema.icalFeeds.name, 'Healthy feed')));
    expect(healthy[0]?.lastSyncStatus).toBe('success');
    const audit = await db.select({ previousValue: schema.auditLogs.previousValue, newValue: schema.auditLogs.newValue }).from(schema.auditLogs).where(eq(schema.auditLogs.propertyId, propertyId));
    expect(JSON.stringify(audit)).not.toContain('private-token');
  });
  it('does not poll inactive or export feeds', async () => {
    await service.update(feedId, propertyId, { isActive: false });
    await service.create({ propertyId, roomTypeId, direction: 'export', name: 'Export' });
    const fetch = downloader(service).mockResolvedValue(calendar());
    await new IcalPollingService(db, config, service).run();
    expect(fetch).not.toHaveBeenCalled(); expect(await blocks()).toEqual([]);
  });
  it('does not hide stale last-success age behind a recent failed attempt', async () => {
    await db.update(schema.icalFeeds).set({ lastSuccessfulSyncAt: new Date(Date.now() - 3_600_000), lastSyncAt: new Date(), lastSyncStatus: 'failed' })
      .where(and(eq(schema.icalFeeds.id, feedId), eq(schema.icalFeeds.propertyId, propertyId)));
    const fetch = downloader(service).mockResolvedValue(calendar());
    await new IcalPollingService(db, config, service).run();
    expect(fetch).not.toHaveBeenCalled(); expect(health()).toMatchObject({ status: 'degraded', staleFeeds: 1, failedFeeds: 1 });
  });
  it('reports worker dependency failure distinctly from a failed feed and recovers on the next sweep', async () => {
    let unavailable = true;
    const guarded = new Proxy(db, { get(target, key, receiver) {
      if (key === 'select' && unavailable) return () => { throw new Error('private-database-url'); };
      return Reflect.get(target, key, receiver);
    } });
    downloader(service).mockResolvedValue(calendar());
    const worker = new IcalPollingService(guarded, config, service);
    await worker.run(); expect(health().status).toBe('unavailable');
    unavailable = false;
    await worker.run(); expect(health().status).toBe('ok');
    expect(JSON.stringify(vi.mocked(Logger.prototype.error).mock.calls)).not.toContain('private-database-url');
  });
  it('shares the reservation inventory mutex before replacing the busy snapshot', async () => {
    let unlock!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const inventory = db.transaction(async (tx) => {
      await tx.select().from(schema.roomTypes).where(and(eq(schema.roomTypes.id, roomTypeId), eq(schema.roomTypes.propertyId, propertyId))).for('update');
      locked(); await release;
    });
    await ready;
    const fetch = downloader(service).mockResolvedValue(calendar());
    let completed = false;
    const syncing = service.syncImportFeed(feedId, propertyId).then(() => { completed = true; });
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(completed).toBe(false); expect(await blocks()).toEqual([]);
    } finally { unlock(); await inventory; await syncing; }
    expect(await blocks()).toHaveLength(1);
  });
  const makeUnits = async () => {
    const ids = [randomUUID(), randomUUID()];
    await db.insert(schema.rooms).values(ids.map((id, i) => ({ id, propertyId, roomTypeId, number: String(i+1) })));
    return ids;
  };
  const exportFor = async (roomId?: string) => {
    const result = await service.create({ propertyId, roomTypeId, roomId, direction: 'export', name: 'Synthetic export' });
    return new URL(result.exportUrl!).searchParams.get('token')!;
  };
  const available = async () => (await new AvailabilityService(db).searchAvailability(propertyId, '2027-11-01', '2027-11-04', roomTypeId)).map(row => row.available);
  const makeReservation = async (roomId?: string) => {
    const guestId = randomUUID(); guestIds.push(guestId);
    const bookingId = randomUUID(), ratePlanId = randomUUID(), id = randomUUID();
    await db.insert(schema.guests).values({ id: guestId, firstName: 'Synthetic', lastName: 'Calendar' });
    await db.insert(schema.bookings).values({ id: bookingId, guestId, propertyId, confirmationNumber: bookingId, source: 'direct' });
    await db.insert(schema.ratePlans).values({ id: ratePlanId, propertyId, roomTypeId, name: 'Synthetic rate', code: id.slice(0,20), type: 'bar', baseAmount: '100', currencyCode:'GBP' });
    await db.insert(schema.reservations).values({ id, propertyId, roomTypeId, roomId, ratePlanId, bookingId, guestId,
      arrivalDate:'2027-11-01', departureDate:'2027-11-04', nights:3, totalAmount:'300', currencyCode:'GBP', status:'confirmed' });
    return id;
  };
  it('counts mirrored unit feeds once, keeps different units separate and retains legacy mappings', async () => {
    const [unitA, unitB] = await makeUnits();
    await service.update(feedId, propertyId, { roomId: unitA });
    const mirror = await service.create({ propertyId, roomTypeId, roomId: unitA, direction: 'import', name: 'Mirror', sourceUrl: 'https://calendar.example.test/mirror.ics' });
    downloader(service).mockResolvedValue(calendar());
    await service.syncImportFeed(feedId, propertyId); await service.syncImportFeed(mirror.feed.id, propertyId);
    expect(await available()).toEqual([1,1,1]);
    await service.update(mirror.feed.id, propertyId, { roomId: unitB }); expect(await available()).toEqual([0,0,0]);
    await service.update(mirror.feed.id, propertyId, { roomId: null }); expect(await available()).toEqual([0,0,0]);
    expect((await blocks())[0]?.externalUid).toBe('stable-uid');
  });
  it('rejects unit mappings outside the property/type and prevents export remapping', async () => {
    const [unitA, unitB] = await makeUnits();
    await expect(service.create({ propertyId: randomUUID(), roomTypeId, roomId: unitA, direction:'import', name:'Wrong', sourceUrl:'https://calendar.example.test/a' })).rejects.toThrow();
    await expect(service.update(feedId, propertyId, { roomId: randomUUID() })).rejects.toThrow(/selected property/);
    const token = await exportFor(unitA); const rows = await service.list({propertyId,direction:'export'});
    await expect(service.update(rows[0]!.id, propertyId, { roomId: unitB })).rejects.toThrow(/fixed/);
    expect(await service.exportCalendar(token)).toContain('BEGIN:VCALENDAR');
  });
  it('exports only the mapped unit and pooled exhaustion, including external busy blocks', async () => {
    const [unitA, unitB] = await makeUnits(); await service.update(feedId, propertyId, {roomId:unitA});
    const fetch = downloader(service).mockResolvedValue(calendar()); await service.syncImportFeed(feedId,propertyId);
    const pool=await exportFor(); const own=await exportFor(unitA); const other=await exportFor(unitB);
    expect(parseIcsBusyBlocks(await service.exportCalendar(pool))).toEqual([]);
    expect(parseIcsBusyBlocks(await service.exportCalendar(other))).toEqual([]);
    expect(parseIcsBusyBlocks(await service.exportCalendar(own))).toHaveLength(1);
    const second=await service.create({propertyId,roomTypeId,roomId:unitB,direction:'import',name:'Another unit',sourceUrl:'https://calendar.example.test/b'});
    fetch.mockResolvedValue(calendar()); await service.syncImportFeed(second.feed.id,propertyId);
    expect(parseIcsBusyBlocks(await service.exportCalendar(pool))).toHaveLength(1);
  });
  it('ignores signed export echoes before UID merging and releases dates when the source cancels', async () => {
    const [unitA] = await makeUnits(); await service.update(feedId,propertyId,{roomId:unitA});
    const fetch=downloader(service).mockResolvedValue(calendar()); await service.syncImportFeed(feedId,propertyId);
    const token=await exportFor(unitA); const published=await service.exportCalendar(token);
    const mirror=await service.create({propertyId,roomTypeId,roomId:unitA,direction:'import',name:'Echo',sourceUrl:'https://calendar.example.test/echo'});
    fetch.mockResolvedValue(published); await service.syncImportFeed(mirror.feed.id,propertyId);
    expect(await service.listBlocks(mirror.feed.id,{propertyId})).toEqual([]);
    fetch.mockResolvedValue(calendar('STATUS:CANCELLED')); await service.syncImportFeed(feedId,propertyId);
    expect(await available()).toEqual([2,2,2]); expect(parseIcsBusyBlocks(await service.exportCalendar(token))).toEqual([]);
    // A changed date cannot inherit the signature of a former export event.
    fetch.mockResolvedValue(published.replace('20271101','20271102')); await service.syncImportFeed(mirror.feed.id,propertyId);
    expect(await service.listBlocks(mirror.feed.id,{propertyId})).toHaveLength(1);
  });
  it('exports assigned stays only to their unit, keeps unassigned holds conservative and excludes cancelled stays', async () => {
    const [unitA, unitB] = await makeUnits(); const own = await exportFor(unitA), other = await exportFor(unitB), pool = await exportFor();
    const id = await makeReservation(unitA);
    expect(parseIcsBusyBlocks(await service.exportCalendar(own))).toHaveLength(1);
    expect(parseIcsBusyBlocks(await service.exportCalendar(other))).toEqual([]);
    expect(parseIcsBusyBlocks(await service.exportCalendar(pool))).toEqual([]);
    await db.update(schema.reservations).set({ roomId:null }).where(and(eq(schema.reservations.id,id),eq(schema.reservations.propertyId,propertyId)));
    expect(parseIcsBusyBlocks(await service.exportCalendar(other))).toHaveLength(1);
    await db.update(schema.reservations).set({status:'cancelled'}).where(and(eq(schema.reservations.id,id),eq(schema.reservations.propertyId,propertyId)));
    expect(parseIcsBusyBlocks(await service.exportCalendar(other))).toEqual([]);
  });
  it('recognises owned legacy reservation UIDs but retains foreign, malformed and altered signed identities', async () => {
    const [unitA] = await makeUnits(); const id = await makeReservation(unitA);
    const fetch = downloader(service).mockResolvedValue(calendar().replace('stable-uid',`${id}@haip`));
    await service.syncImportFeed(feedId,propertyId); expect(await blocks()).toEqual([]);
    fetch.mockResolvedValue(calendar().replace('stable-uid',`${randomUUID()}@haip`));
    await service.syncImportFeed(feedId,propertyId); expect(await blocks()).toHaveLength(1);
    fetch.mockResolvedValue(calendar().replace('stable-uid',`${'a'.repeat(36)}@haip`));
    await service.syncImportFeed(feedId,propertyId); expect(await blocks()).toHaveLength(1);
  });

});

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
});

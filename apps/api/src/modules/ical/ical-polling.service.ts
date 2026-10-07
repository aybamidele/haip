import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@telivityhaip/database';
import { icalFeeds } from '@telivityhaip/database';
import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { DRIZZLE } from '../../database/database.module';
import { IcalService } from './ical.service';

export const ICAL_WORKER_HEALTH_FILE = '/tmp/haip-ical-worker-health.json';
export interface CalendarWorkerHealth {
  status: 'starting' | 'ok' | 'degraded' | 'unavailable';
  checkedAt: string;
  intervalMs: number;
  activeFeeds: number;
  failedFeeds: number;
  staleFeeds: number;
}

/** Standalone PMS worker only: no second inventory engine or guest API credentials. */
@Injectable()
export class IcalPollingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IcalPollingService.name);
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private health: CalendarWorkerHealth;

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    config: ConfigService,
    private readonly ical: IcalService,
  ) {
    this.intervalMs = Number(config.get<string>('ICAL_POLL_INTERVAL_MS', '300000'));
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 60_000 || this.intervalMs > 3_600_000) {
      throw new Error('ICAL_POLL_INTERVAL_MS must be between 60000 and 3600000');
    }
    this.health = { status: 'starting', checkedAt: new Date().toISOString(), intervalMs: this.intervalMs, activeFeeds: 0, failedFeeds: 0, staleFeeds: 0 };
  }

  onModuleInit(): void {
    this.publish();
    this.timer = setInterval(() => void this.run(), 15_000);
    void this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }

  run(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.sweep().finally(() => { this.active = undefined; });
    return this.active;
  }

  private publish(): void {
    this.health.checkedAt = new Date().toISOString();
    const temporary = `${ICAL_WORKER_HEALTH_FILE}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.health), { mode: 0o600 });
    renameSync(temporary, ICAL_WORKER_HEALTH_FILE);
  }

  private async sweep(): Promise<void> {
    const syncRunId = randomUUID();
    const started = Date.now();
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    try {
      const dueBefore = new Date(started - this.intervalMs);
      // Trusted internal worker scans tenants; all mutations still carry explicit propertyId.
      const due = await this.db.select({ id: icalFeeds.id, propertyId: icalFeeds.propertyId })
        .from(icalFeeds).where(and(eq(icalFeeds.isActive, true), eq(icalFeeds.direction, 'import'),
          or(isNull(icalFeeds.lastSyncAt), lte(icalFeeds.lastSyncAt, dueBefore))))
        .orderBy(asc(icalFeeds.lastSyncAt), asc(icalFeeds.createdAt)).limit(25);
      for (const feed of due) {
        if (this.stopping) break;
        const feedStarted = Date.now();
        try {
          const result = await this.ical.syncImportFeed(feed.id, feed.propertyId, dueBefore);
          if ('skipped' in result) { skipped++; continue; }
          succeeded++;
          this.logger.log({ event: 'ical_sync_succeeded', provider: 'ical', syncRunId, feedId: feed.id,
            propertyId: feed.propertyId, blocksImported: result.blocksImported, durationMs: Date.now() - feedStarted });
        } catch {
          failed++;
          this.logger.warn({ event: 'ical_sync_failed', provider: 'ical', syncRunId, feedId: feed.id,
            propertyId: feed.propertyId, durationMs: Date.now() - feedStarted });
        } finally { this.publish(); }
      }
      const feeds = await this.db.select({ lastSyncStatus: icalFeeds.lastSyncStatus,
        lastSuccessfulSyncAt: icalFeeds.lastSuccessfulSyncAt, createdAt: icalFeeds.createdAt })
        .from(icalFeeds).where(and(eq(icalFeeds.isActive, true), eq(icalFeeds.direction, 'import')));
      const staleBefore = Date.now() - Math.max(this.intervalMs * 3, 600_000);
      const failedFeeds = feeds.filter((feed) => feed.lastSyncStatus === 'failed').length;
      const staleFeeds = feeds.filter((feed) => (feed.lastSuccessfulSyncAt ?? feed.createdAt).getTime() < staleBefore).length;
      this.health = { ...this.health, status: failedFeeds || staleFeeds ? 'degraded' : 'ok', activeFeeds: feeds.length, failedFeeds, staleFeeds };
      if (due.length || staleFeeds) this.logger.log({ event: 'ical_sweep_completed', provider: 'ical', syncRunId,
        succeeded, failed, skipped, activeFeeds: feeds.length, failedFeeds, staleFeeds, durationMs: Date.now() - started });
    } catch {
      this.health.status = 'unavailable';
      this.logger.error({ event: 'ical_sweep_failed', provider: 'ical', syncRunId });
    } finally { this.publish(); }
  }
}

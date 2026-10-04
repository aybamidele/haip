import { Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { and, eq, lte, notExists, gt, inArray } from 'drizzle-orm';
import { reservations, icalFeeds, payments, folios } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { WebhookService } from '../webhook/webhook.service';
import { IcalService } from '../ical/ical.service';

/** PMS-owned maintenance. Atomic pending-only updates cannot cancel a confirmed stay. */
@Injectable()
export class BookingMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingMaintenanceService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private lastSync = 0;
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly webhooks: WebhookService, private readonly ical: IcalService) {}
  onModuleInit() { this.timer = setInterval(() => void this.run(), 15_000); this.timer.unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const expired = await this.db.update(reservations).set({ status: 'cancelled', cancelledAt: new Date(), cancellationReason: 'Unpaid hold expired', updatedAt: new Date() })
        .where(and(eq(reservations.status, 'pending'), lte(reservations.holdExpiresAt, new Date()), notExists(this.db.select({ id: payments.id }).from(payments).innerJoin(folios, and(eq(folios.id, payments.folioId), eq(folios.propertyId, payments.propertyId))).where(and(eq(folios.reservationId, reservations.id), eq(folios.propertyId, reservations.propertyId), gt(payments.amount, '0'), inArray(payments.status, ['captured', 'settled'])))))).returning();
      for (const row of expired) await this.webhooks.emit('reservation.cancelled', 'reservation', row.id,
        { reservationId: row.id, roomTypeId: row.roomTypeId, arrivalDate: row.arrivalDate, departureDate: row.departureDate, cancellationReason: 'Unpaid hold expired' }, row.propertyId);
      if (Date.now() - this.lastSync >= 300_000) {
        this.lastSync = Date.now();
        const feeds = await this.db.select().from(icalFeeds).where(and(eq(icalFeeds.isActive, true), eq(icalFeeds.direction, 'import')));
        for (const feed of feeds) {
          try { await this.ical.syncImportFeed(feed.id, feed.propertyId); }
          catch { this.logger.warn({ event: 'ical_poll_failed', feedId: feed.id, propertyId: feed.propertyId }); }
        }
      }
    } catch { this.logger.error({ event: 'booking_maintenance_failed' }); }
    finally { this.running = false; }
  }
}

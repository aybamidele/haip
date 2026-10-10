import { Inject, Injectable, Logger, Optional, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { and, eq, lte, notExists, gt, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { reservations, payments, folios } from '@telivityhaip/database';
import { StripeCheckoutService } from '../payment/stripe-checkout.service';
import { DRIZZLE } from '../../database/database.module';
import { WebhookService } from '../webhook/webhook.service';

/** PMS-owned maintenance. Receipt writers and expiry serialize on the reservation. */
@Injectable()
export class BookingMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingMaintenanceService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase, private readonly webhooks: WebhookService, @Optional() private readonly checkout?: StripeCheckoutService) {}
  onModuleInit() { this.timer = setInterval(() => void this.run(), 15_000); this.timer.unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const expired = await this.db.transaction(async tx => {
        const now = new Date();
        // A locked receipt/confirmation is picked up next sweep. Bound a sweep's
        // write locks; re-check money in a NEW statement after acquiring the lock.
        // A single UPDATE's subquery retains its pre-wait READ COMMITTED snapshot.
        const alreadyReceived = tx.select({ id: payments.id }).from(payments)
          .innerJoin(folios, and(eq(folios.id, payments.folioId), eq(folios.propertyId, payments.propertyId)))
          .where(and(eq(folios.reservationId, reservations.id), eq(folios.propertyId, reservations.propertyId),
            gt(payments.amount, '0'), inArray(payments.status, ['captured', 'settled'])));
        const candidates = await tx.select({ id: reservations.id, propertyId: reservations.propertyId })
          .from(reservations).where(and(eq(reservations.status, 'pending'), lte(reservations.holdExpiresAt, now), notExists(alreadyReceived)))
          .orderBy(reservations.holdExpiresAt, reservations.id).limit(100).for('update', { skipLocked: true });
        const cancelled: (typeof reservations.$inferSelect)[] = [];
        for (const candidate of candidates) {
          const receivedMoney = tx.select({ id: payments.id }).from(payments)
            .innerJoin(folios, and(eq(folios.id, payments.folioId), eq(folios.propertyId, payments.propertyId)))
            .where(and(eq(folios.reservationId, candidate.id), eq(folios.propertyId, candidate.propertyId),
              gt(payments.amount, '0'), inArray(payments.status, ['captured', 'settled'])));
          const rows = await tx.update(reservations).set({ status: 'cancelled', cancelledAt: now,
            cancellationReason: 'Unpaid hold expired', updatedAt: now })
            .where(and(eq(reservations.id, candidate.id), eq(reservations.propertyId, candidate.propertyId),
              eq(reservations.status, 'pending'), lte(reservations.holdExpiresAt, now), notExists(receivedMoney))).returning();
          cancelled.push(...rows);
        }
        return cancelled;
      });
      for (const row of expired) await this.webhooks.emit('reservation.cancelled', 'reservation', row.id,
        { reservationId: row.id, roomTypeId: row.roomTypeId, arrivalDate: row.arrivalDate, departureDate: row.departureDate, cancellationReason: 'Unpaid hold expired' }, row.propertyId);
    } catch { this.logger.error({ event: 'booking_maintenance_failed' }); }
    finally {
      try { await this.checkout?.expireSessions(); } catch { this.logger.error({ event: 'stripe_checkout_expiry_failed' }); }
      this.running = false;
    }
  }
}

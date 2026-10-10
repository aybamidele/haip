import { Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { auditLogs, stripeWebhookEvents } from '@telivityhaip/database';
import type Stripe from 'stripe';
import { DRIZZLE } from '../../database/database.module';
import { WebhookService, type WebhookPayload } from '../webhook/webhook.service';

export type StripeEmit = (event: WebhookPayload['event'], entityType: string, entityId: string,
  data: Record<string, unknown>, propertyId: string) => Promise<void>;

/** The event claim, ledger effects and audit/outbox commit together. No raw provider PII is retained. */
@Injectable()
export class StripeEventService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(StripeEventService.name);
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly webhooks: WebhookService) {}
  onModuleInit() { this.timer = setInterval(() => void this.retry(), 15_000); this.timer.unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** Domain writers stage audit and notification consequences in their existing transaction. */
  async enqueue(tx: any, identity: string, consequences: Omit<WebhookPayload, 'timestamp' | 'logicalEventId'>[]) {
    const payloads = consequences.map((payload, i) => ({ ...payload, timestamp: new Date().toISOString(), logicalEventId: `${identity}:${i}` }));
    for (const payload of payloads) {
      await tx.insert(auditLogs).values({ propertyId: payload.propertyId ?? null, action: 'create',
        entityType: payload.entityType, entityId: payload.entityId, description: `Webhook event: ${payload.event}`, newValue: payload });
    }
    await tx.insert(stripeWebhookEvents).values({ eventId: identity, eventType: 'haip.operation', livemode: false,
      propertyId: payloads[0]?.propertyId ?? null, processedAt: new Date(), consequences: payloads });
  }

  async process(event: Stripe.Event, handler: (tx: any, emit: StripeEmit) => Promise<void>) {
    // Global lookup is intentional: only a signature-verified server event can call this method.
    await this.db.transaction(async (tx: any) => {
      await tx.insert(stripeWebhookEvents).values({ eventId: event.id, eventType: event.type,
        livemode: event.livemode }).onConflictDoNothing();
      const [receipt] = await tx.select().from(stripeWebhookEvents)
        .where(eq(stripeWebhookEvents.eventId, event.id)).for('update');
      if (!receipt || receipt.eventType !== event.type || receipt.livemode !== event.livemode) {
        throw new Error('Stripe event identity mismatch');
      }
      if (receipt.processedAt) return;
      const consequences: WebhookPayload[] = [];
      const emit: StripeEmit = async (kind, entityType, entityId, data, propertyId) => {
        const payload = { event: kind, entityType, entityId, data, propertyId,
          timestamp: new Date().toISOString(), logicalEventId: `stripe:${event.id}:${consequences.length}` };
        await tx.insert(auditLogs).values({ propertyId, action: 'create', entityType, entityId,
          description: `Webhook event: ${kind}`, newValue: payload });
        consequences.push(payload);
      };
      await handler(tx, emit);
      await tx.update(stripeWebhookEvents).set({ processedAt: new Date(), consequences,
        propertyId: consequences[0]?.propertyId ?? null })
        .where(eq(stripeWebhookEvents.eventId, event.id));
    });
    // Dispatch is a recoverable consequence. A delivery failure does not discard the committed outbox.
    try { await this.dispatch(event.id); } catch { this.logger.warn({ event: 'stripe_outbox_pending', eventId: event.id }); }
  }

  private async dispatch(eventId: string) {
    await this.db.transaction(async (tx: any) => {
      const [receipt] = await tx.select().from(stripeWebhookEvents)
        .where(eq(stripeWebhookEvents.eventId, eventId)).for('update');
      if (!receipt?.processedAt || receipt.dispatchedAt) return;
      for (const payload of receipt.consequences as WebhookPayload[]) {
        await this.webhooks.dispatchPersisted(payload, payload.logicalEventId!);
      }
      await tx.update(stripeWebhookEvents).set({ dispatchedAt: new Date() })
        .where(eq(stripeWebhookEvents.eventId, eventId));
    });
  }
  async retry() {
    try {
      const rows = await this.db.select({ eventId: stripeWebhookEvents.eventId }).from(stripeWebhookEvents)
        .where(and(isNotNull(stripeWebhookEvents.processedAt), isNull(stripeWebhookEvents.dispatchedAt))).limit(100);
      for (const row of rows) {
        try { await this.dispatch(row.eventId); } catch { this.logger.warn({ event: 'stripe_outbox_pending', eventId: row.eventId }); }
      }
    } catch { this.logger.error({ event: 'stripe_outbox_retry_failed' }); }
  }
}

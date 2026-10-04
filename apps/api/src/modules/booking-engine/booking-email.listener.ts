import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, eq } from 'drizzle-orm';
import { reservations, bookings, guests, properties, folios } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { EmailService } from '../agent/guest-comms/email.service';
import type { WebhookPayload } from '../webhook/webhook.service';

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
/** Opt-in transactional notifications using the existing PMS mail transport. */
@Injectable()
export class BookingEmailListener {
  private readonly logger = new Logger(BookingEmailListener.name);
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly email: EmailService) {}
  @OnEvent('reservation.created') async created(event: WebhookPayload) { await this.send(event, 'Booking awaiting manual payment', true); }
  @OnEvent('reservation.confirmed') async confirmed(event: WebhookPayload) { await this.send(event, 'Booking confirmed'); }
  @OnEvent('reservation.cancelled') async cancelled(event: WebhookPayload) { await this.send(event, 'Booking cancelled'); }
  @OnEvent('payment.received') async payment(event: WebhookPayload) {
    if (!event.propertyId || typeof event.data['folioId'] !== 'string') return;
    try {
      const [folio] = await this.db.select().from(folios).where(and(eq(folios.id, event.data['folioId']), eq(folios.propertyId, event.propertyId)));
      if (folio?.reservationId) {
        if (event.data['status'] === 'captured' && Number(event.data['amount']) > 0) {
          await this.db.update(reservations).set({ holdExpiresAt: null, updatedAt: new Date() }).where(and(eq(reservations.id, folio.reservationId), eq(reservations.propertyId, event.propertyId), eq(reservations.status, 'pending')));
        }
        await this.send({ ...event, entityId: folio.reservationId }, event.data['status'] === 'authorized' ? 'Card authorization received' : 'Payment recorded');
      }
    } catch { this.logger.warn({ event: 'booking_payment_email_failed', propertyId: event.propertyId }); }
  }
  private async send(event: WebhookPayload, subject: string, manualOnly = false) {
    if (process.env['BOOKING_TRANSACTIONAL_EMAILS'] !== 'true' || !event.propertyId) return;
    try {
      const [row] = await this.db.select({ reservation: reservations, booking: bookings, guest: guests, property: properties }).from(reservations)
        .innerJoin(bookings, eq(bookings.id, reservations.bookingId)).innerJoin(guests, eq(guests.id, reservations.guestId)).innerJoin(properties, eq(properties.id, reservations.propertyId))
        .where(and(eq(reservations.id, event.entityId), eq(reservations.propertyId, event.propertyId)));
      if (!row?.guest.email || row.booking.channelCode !== 'booking_engine' || (manualOnly && !row.reservation.holdExpiresAt)) return;
      const staging = process.env['STRIPE_MODE'] === 'mock' ? 'STAGING: synthetic accommodation; no real payment.\n\n' : '';
      const text = `${staging}${subject}\n${row.property.name}\n${row.reservation.arrivalDate} to ${row.reservation.departureDate}\n${row.reservation.currencyCode} ${row.reservation.totalAmount}\nConfirmation: ${row.booking.confirmationNumber}\n${row.reservation.holdExpiresAt ? `Unpaid hold expires: ${row.reservation.holdExpiresAt.toISOString()}` : ''}`;
      await this.email.send({ to: row.guest.email, subject: `${staging ? '[STAGING] ' : ''}${subject}`, text, html: `<p>${escape(text).replaceAll('\n', '<br>')}</p>` });
    } catch { this.logger.warn({ event: 'booking_email_failed', reservationId: event.entityId, propertyId: event.propertyId }); }
  }
}

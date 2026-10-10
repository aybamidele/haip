import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, timestamp, jsonb, boolean, numeric, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { properties } from './property.js';
import { reservations } from './reservation.js';
import { folios, payments } from './folio.js';
import { fiscalDocuments } from './fiscal-document.js';

/** Signed provider inbox. Global event ids are trusted internal receiver identities.
 * propertyId is nullable because unrelated account events have no PMS tenant. */
export const stripeWebhookEvents = pgTable('stripe_webhook_events', {
  eventId: varchar('event_id', { length: 255 }).primaryKey(),
  propertyId: uuid('property_id').references(() => properties.id),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  livemode: boolean('livemode').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  consequences: jsonb('consequences').$type<Record<string, unknown>[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Reservation and payment identity survive lost responses and provider timeouts. */
export const directBookingAttempts = pgTable('direct_booking_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  keyHash: varchar('key_hash', { length: 64 }).notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  reservationId: uuid('reservation_id').references(() => reservations.id),
  paymentId: uuid('payment_id').references(() => payments.id),
  response: jsonb('response').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({ key: uniqueIndex('direct_booking_attempts_property_key_unique').on(table.propertyId, table.keyHash) }));

/** Provider transport state only; financial truth stays in the payment/folio ledger. */
export const stripeCheckouts = pgTable('stripe_checkouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  reservationId: uuid('reservation_id').notNull().references(() => reservations.id),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  stripeAccountId: varchar('stripe_account_id', { length: 255 }).notNull(),
  sessionId: varchar('session_id', { length: 255 }),
  sessionUrl: text('session_url'),
  returnUrl: text('return_url').notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  autoConfirm: boolean('auto_confirm').notNull(),
  refundable: boolean('refundable').notNull(),
  reconciliationRequired: boolean('reconciliation_required').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({ payment: uniqueIndex('stripe_checkouts_property_payment_unique').on(table.propertyId, table.paymentId),
  session: uniqueIndex('stripe_checkouts_session_unique').on(table.sessionId), expiry: index('stripe_checkouts_expiry_idx').on(table.expiresAt) }));

/** An invoice collects one persisted folio balance snapshot. */
export const stripeInvoices = pgTable('stripe_invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  folioId: uuid('folio_id').notNull().references(() => folios.id),
  documentId: uuid('document_id').notNull().references(() => fiscalDocuments.id),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  stripeAccountId: varchar('stripe_account_id', { length: 255 }).notNull(),
  customerId: varchar('customer_id', { length: 255 }),
  invoiceId: varchar('invoice_id', { length: 255 }),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  currencyCode: varchar('currency_code', { length: 3 }).notNull(),
  billingEmail: text('billing_email').notNull(),
  billingName: text('billing_name').notNull(),
  description: text('description').notNull(),
  dueDays: varchar('due_days', { length: 3 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('creating'),
  hostedUrl: text('hosted_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({ document: uniqueIndex('stripe_invoices_property_document_unique').on(table.propertyId, table.documentId),
  invoice: uniqueIndex('stripe_invoices_invoice_unique').on(table.invoiceId),
  activeFolio: uniqueIndex('stripe_invoices_one_active_folio').on(table.propertyId, table.folioId)
    .where(sql`${table.status} IN ('creating','draft','open','uncollectible')`) }));

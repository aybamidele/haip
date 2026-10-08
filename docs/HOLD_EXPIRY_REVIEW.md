# Reviewing unpaid hold expiry

## What changed
Expiry first locks a bounded batch of eligible reservation rows with `FOR UPDATE SKIP LOCKED`, then rechecks received money in a fresh statement before cancellation. Manual receipt recording uses the same reservation lock. This prevents a pre-payment statement snapshot from cancelling a hold after a committed receipt. Multiple workers can process expiry safely.

Existing policy is preserved: any positive captured/settled receipt protects a pending hold. Authorized, failed, zero or negative records do not. A late receipt is recorded without reviving cancelled inventory. Provider settlement and financial reconciliation remain separate concerns.

## Automated PostgreSQL review
Use a disposable migrated database, never a production connection. Set `HOLD_TEST_DATABASE_URL` to it and run:

```sh
pnpm --filter @telivityhaip/api test src/modules/booking-engine/hold-expiry.integration.spec.ts src/modules/payment/payment.service.spec.ts
pnpm --filter @telivityhaip/api typecheck
pnpm --filter @telivityhaip/api build
```

The integration suite creates and removes UUID-scoped synthetic fixtures. It proves inventory release, replay/multiple workers, money states, a receipt writer owning the reservation lock, and actual PaymentService recording after expiry wins. CI supplies the opt-in PostgreSQL URL.

## Guided manual review
Use an isolated preview with simulated payments and synthetic inventory. Do not shorten a shared environment’s hold duration.

1. Set a short preview-only `BOOKING_MANUAL_HOLD_MINUTES` (for example 1), restart its API, and choose a free synthetic unit/date window.
2. Create a pending hold through the normal booking flow. Verify another guest cannot book the last unit during the hold.
3. Leave it unpaid. Wait past the deadline plus the maintenance interval (15 seconds). Verify it becomes cancelled, and the dates become available again. Repeat after restarting the API before the deadline.
4. Create another hold and record a positive manual receipt on its folio before expiry. After the deadline, verify it remains protected. This patch does not auto-confirm a manually paid pending reservation.
5. Let another unpaid hold expire, then record money that arrived late. Verify the receipt exists for staff reconciliation, the stay stays cancelled and inventory remains available.

For deterministic concurrency, use the PostgreSQL suite rather than timing clicks. Cancel remaining owned stays, retain receipt audit records as appropriate, and restore the preview-only hold setting. This is not proof of real provider webhooks, refunds or a durable communications outbox.

# Reviewing staff stay-date editing

## What changed
Reservations → select a row → Edit stay dates exposes HAIP’s existing property-scoped date modification operation. It is available for writable, pending/confirmed/assigned direct stays. The server remains authoritative for inventory and physical-unit conflicts.

This operation changes dates without recalculating the agreed total. Review the folio separately. Accepted pricing snapshots require a Stay Amendment: this editor does not bypass that guard. Booking Requests already have their own amendment workflow. A general direct-booking accepted-pricing amendment is outside this patch.

## Automated checks
After installing dependencies and building workspace packages, run `pnpm --filter @telivityhaip/dashboard test`, `pnpm --filter @telivityhaip/dashboard typecheck`, and `pnpm --filter @telivityhaip/dashboard build`. Tests cover scoped dates-only writes, invalid/unchanged dates, focus, cancellation, permission visibility, terminal/OTA stays and conflict recovery.

## Guided manual review
Use an isolated demo/preview. Create a synthetic direct reservation through the staff creation flow, with an unfrozen tariff and available dates. Record its dates, total and room assignment before starting.

1. Open Reservations, select its row, then Edit stay dates. Focus should move to Arrival. The dates-only pricing explanation should be visible.
2. Extend departure into free inventory and save. The drawer and list should update; reload and confirm persisted dates. The agreed total must remain unchanged.
3. Try departure before arrival or unchanged dates. Save must remain disabled and the explanation should identify the problem.
4. Occupy the proposed dates with another synthetic stay (including the assigned physical unit when applicable). Try extending into those dates. The server should reject it, the original reservation must remain unchanged, and draft dates must remain available for correction.
5. Try a reservation carrying accepted pricing. The server must require a Stay Amendment; no dates or money should change.
6. Press Escape or Cancel before saving. No write should occur and focus should return to Edit stay dates.
7. Repeat on a phone-sized viewport and with a read-only staff role. The editor should fit the drawer; read-only staff must not see the edit action.

Cancel the owned synthetic stays or restore their dates. Do not use guest direct bookings as the successful-edit fixture: their accepted-pricing snapshot deliberately blocks this operation.

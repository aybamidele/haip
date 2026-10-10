# Stripe hosted payments and invoice operations

This implementation keeps financial truth in HAIP's existing payments, deposits and folios. The booking engine creates an inventory hold and a durable attempt before creating a Stripe-hosted Checkout session. Stripe SDK 23.0.0 uses API version `2026-09-30.endive`; configure the webhook endpoint to the same version. Provider acceptance is required before enabling this flow.

## Configuration

Provide secrets in protected runtime environment variables, never in source control or browser bundles.

| Variable | Purpose |
| --- | --- |
| `PAYMENT_GATEWAY=stripe` | Select the real Stripe gateway. |
| `STRIPE_MODE=test` | Isolated sandbox; use separate live credentials and configuration later. |
| `STRIPE_ACCOUNT_ID` | Expected `acct_` identity, verified using `GET /v1/account` before hosted-payment, invoice and refund mutations. |
| `STRIPE_SECRET_KEY` | Restricted server key matching the configured mode. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for this endpoint and account. |
| `BOOKING_RETURN_ORIGINS` | Comma-separated exact allowed return origins; HTTPS in production, no wildcards. |
| `BOOKING_CARD_HOLD_MINUTES=30` | Bounded inventory hold, integer 30–1440 minutes. Confirm the business policy before launch. |
| `STRIPE_CHECKOUT_INVOICES=false` | Optional post-payment Checkout invoice document; it creates no additional HAIP ledger credit. |

Restricted permissions follow the actual API calls: Account read; Checkout Sessions, Customers, Invoices and Invoice Items write; Invoice Payments read; Payment Intents read (write if using the existing staff gateway); Refunds write. Write includes read. Additional saved-card workflows need their own Setup Intent/Payment Method permissions. Match these resources to Dashboard permission groups and verify sandbox request logs; do not enable unrelated resources. See [restricted keys](https://docs.stripe.com/keys/restricted-api-keys.md).

Hosted Checkout requires no browser secret or publishable key. MCP OAuth and Stripe CLI authentication do not configure the application key.

## Webhooks

Use `POST /api/v1/webhooks/stripe`, whose raw-body middleware preserves signature verification. Subscribe to:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`.
- `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`.
- `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled` for existing gateway workflows.
- `refund.created`, `refund.updated`, `refund.failed`, `charge.refunded`.

Invalid signatures return 400; failed durable processing returns a retryable 503. The signed event claim, business mutations and audit/notification outbox commit together for the new flows. Delivery retries use existing stable logical webhook identities. Booking-request payments retain their existing package transaction and outbox mechanisms.

A browser redirect never proves settlement. A completed session with unpaid funds remains pending. HAIP retrieves current provider objects, verifies association, amount, currency, mode and account, then records a successful payment once. Refund history is reconciled before auto-confirmation, so a historical settlement event cannot confirm an already refunded stay.

## Booking contract and recovery

The supported booking-engine create request accepts `idempotencyKey` (16–128 allowed characters) and `returnUrl`. Real Stripe card checkout requires the key. The response includes `deposit.nextAction`, a redirect to the hosted session, while the reservation remains pending.

The same key and request recover the same reservation and provider session. Changed request data under a reused key returns conflict. Accepted prices come from canonical HAIP rates, not browser amounts. The final-unit availability check and attempt claim share the canonical booking transaction.

The inventory expiry is authoritative. Maintenance releases unpaid holds and explicitly expires open provider sessions. Session creation omits native `expires_at` to keep provider parameters identical after delayed retries; Stripe's default session lifetime is a fallback if maintenance cannot reach Stripe. Therefore local inventory expiry can precede provider expiry. Late successful funds are recorded and marked `reconciliationRequired`, never used to revive cancelled/reallocated inventory. Operational staff must inspect the payment/reservation and resolve or refund the exception.

## Invoice workflow

All routes below are under `/api/v1`, require staff authentication and property scope, and reuse `folios.manage` or `folios.read` permission.

1. Request a fiscal document with `POST /folios/{folioId}/fiscal-documents`, body `{ "propertyId": "<uuid>", "documentType": "invoice" }`.
2. Create a draft with `POST /stripe-invoices`, body `{ "propertyId": "<uuid>", "folioId": "<uuid>", "documentId": "<requested-document-uuid>", "dueDays": 14 }`. Terms are explicit, 1–365 days. Repeating the same document recovers its draft.
3. Review the draft in Stripe, including the business identity, tax details, recipient and agreed terms. This version creates one explicit item for the HAIP balance snapshot; it excludes unrelated pending customer items and does not enable automatic tax.
4. Call `POST /stripe-invoices/{id}/send?propertyId={uuid}`. HAIP revalidates the balance, finalizes, sends and records the official document and hosted URL. `GET /stripe-invoices/{id}?propertyId={uuid}` returns the reference.
5. To change the collectible balance or use another payment method, first call `POST /stripe-invoices/{id}/void?propertyId={uuid}`. Drafts are deleted; finalized unpaid invoices are voided. A paid invoice needs separate refund/credit-note reconciliation.

Only one creating/draft/open/uncollectible invoice is allowed per folio. An uncollectible invoice can still be paid in Stripe, so its guard remains until void or verified payment. Pending gateway collection blocks new invoices; active invoices block additional manual/gateway collection. Charge corrections, reversals, transfers and accepted-stay amendments are blocked while an invoice holds the charge snapshot. A folio-locking PostgreSQL trigger also prevents competing financial charge writes; night-audit lock annotations remain writable.

Only a verified successful PaymentIntent linked through Invoice Payments credits the folio. Out-of-band payments, customer credits or multiple payment allocations fail closed for explicit staff reconciliation; they do not invent Stripe funds. Checkout post-payment document events do not credit the ledger again.

Do not void only the HAIP fiscal-document record or alter provider invoice items directly: use the Stripe issuer route to coordinate both sides. No new dashboard invoice-management screen is included.

## Refunds

`POST /payments/{id}/refund?propertyId={uuid}` accepts `{ "amount": "25.00", "idempotencyKey": "<stable-refund-intent>" }`. Every explicit-amount Stripe refund requires its own stable key. Retain that key across HTTP retries; a separate intended partial refund needs a new key. Omitting amount means the remaining captured balance and uses a stable full-refund identity. The existing dashboard generates and retains a key for its open refund dialog.

A pending negative payment child durably reserves the refundable amount before submitting the provider request. Pending/failed/cancelled refunds do not reduce the folio's payments. Verified success credits the refund once and releases a fully returned linked advance liability. Provider Dashboard refunds are reconciled from current refund objects, not an aggregate charge amount that can include pending refunds.

Unknown provider outcomes remain pending and recover under the same Stripe key. An unresolved create attempt older than 23 hours requires provider reconciliation rather than a new mutation after Stripe's idempotency cache could expire. Missing key permissions or definitive create errors currently also retain the claim until retry/reconciliation; never replace it with a fresh intent to bypass the reserve.

## Deployment and acceptance

Apply migration `0030_stripe_operations.sql` and deploy compatible HAIP before consumers start sending the new direct-booking identity. Database and code rollback must be coordinated; reverting code alone can leave financial operations requiring the new reconciler. Keep invoice/refund state and event receipts when rolling back. Disable new collection while investigating provider mismatches.

Tests with real PostgreSQL use `STRIPE_OPERATIONS_LIVE_PG=1` and a disposable `DATABASE_URL`, synthetic accommodation, and a simulated Stripe API. They demonstrate ledger/inventory concurrency and recovery, not Stripe network behavior, SCA, delivery configuration or legal invoice compliance. CI runs this database gate and the existing workspace tests.

Acceptance still needs real sandbox Checkout/SCA, delayed/failed methods, abandoned sessions, lost responses, signed provider retries, current refund transitions, delivered invoice emails and hosted invoice payment. Enable only methods proven for the booking hold policy. Credit-note automation, out-of-band invoice allocation and new staff invoice UI are outside this implementation. Existing staff manual-capture authorization remains a separate legacy workflow and needs its own provider acceptance; it is not the guest pay-now path.

Monitor pending event dispatch, unresolved payment/refund/invoice attempts and checkout reconciliation flags. Background sweeps process bounded batches; a large persistent failure backlog needs operator intervention. A fully refunded but previously captured pending stay can retain inventory until staff reconciliation because the existing hold-expiry predicate conservatively recognizes its captured parent payment.

## Recorded local verification

On 2026-10-10 the complete workspace passed **2,634 tests across 303 files with passing tests**, excluding skipped cases/files from the published totals. This includes 20 Stripe operations tests against PostgreSQL 18 with a simulated provider and 6 account/money boundary tests. The fresh migrate/seed/full-module reservation lifecycle smoke passed separately (1 test). Workspace production builds and type checks passed; API lint reported zero errors, with existing and additional style/type warnings still present. CI targets PostgreSQL 16 and has not yet run on these local commits. These results do not establish real Stripe or deployed readiness.

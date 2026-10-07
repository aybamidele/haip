# Scheduled operations (external cron)

HAIP does not run in-process cron jobs. Use an external scheduler (system cron, Kubernetes CronJob, GitHub Actions, etc.) to call these authenticated API endpoints on a schedule.

All requests require a valid Keycloak JWT with the appropriate role unless noted.

Base URL: `https://<your-host>/api/v1`

## Night audit

Run once per property per business date (typically after midnight local time).

```
POST /night-audit/run
Authorization: Bearer <token>
Content-Type: application/json

{ "propertyId": "<uuid>", "businessDate": "2026-07-01" }
```

Role: `admin` or `night_auditor`

## AI agent training

Train all enabled agents on property history (recommended nightly).

```
POST /agents/<propertyId>/train-all
Authorization: Bearer <token>
```

Role: `admin`

## AI agent runs (orchestration)

HAIP does not run in-process agent cron. Use `scripts/cron/agent-runs.sh <agentType>` (or call the API directly).

```
POST /agents/<propertyId>/<agentType>/run?triggeredBy=schedule
Authorization: Bearer <token>
```

Role: `admin`

### Default schedule matrix

| Trigger | Agents | Notes |
|---------|--------|-------|
| `0 6 * * *` | `revenue_manager` | Owns revenue cadence; pulls demand + levers |
| `0 6 * * *` | `ar_collections` | Daily ops / commercial |
| `0 8 * * *` | `housekeeping` | Daily ops window |
| `0 */6 * * *` | `cancellation` | Every 6 hours |
| `0 23 * * *` | `night_audit` | Before night-audit close |
| `0 7 * * *` | `guest_comms` | Pre-arrival, day-of, delayed post-stay, win-back |
| `0 * * * *` | Review ingest | `POST /reviews/ingest?propertyId=<uuid>` per property |
| Events | `guest_comms`, `review_response` | Reservation lifecycle (confirmation, welcome) / review ingest |
| Manual | Any specialist + RManager | Dashboard **Run Now** or `triggeredBy=manual` |

**Do not** independently cron `demand_forecast`, `pricing`, `overbooking`, `channel_mix`, or `group_pickup` — they run via RManager and would double-fire. See [`docs/agents-orchestration.md`](../agents-orchestration.md).

## Group block cutoffs (auto-release sweep)

Release all blocks past their cutoff date for a property. Run daily (typically after night audit).

```
POST /groups/blocks/process-cutoffs?propertyId=<uuid>
Authorization: Bearer <token>
```

Role: `admin`, `night_auditor`, or `revenue_manager`

## Group allotment release (single block)

Release unsold group inventory for one block (call from night audit workflow or on demand).

```
POST /groups/blocks/<blockId>/release?propertyId=<uuid>
Authorization: Bearer <token>
```

Role: `admin`, `front_desk`, or `revenue_manager`

## Channel ARI push (optional)

Push availability/rates to connected OTAs (daily or on-demand).

```
POST /channels/push/full
Authorization: Bearer <token>
Content-Type: application/json

{
  "propertyId": "<uuid>",
  "channelConnectionId": "<uuid>",
  "startDate": "2026-07-01",
  "endDate": "2026-07-31"
}
```

Role: `admin`

## Health check (unauthenticated)

```
GET /health
```

Use for load balancer / uptime monitoring.

## Review ingest (scheduled pull)

Pull configured review sources (Google Places, TripAdvisor) into `guest_reviews` with dedupe. Run hourly per property when integrations are enabled.

```
POST /reviews/ingest?propertyId=<uuid>
Authorization: Bearer <token>
```

Role: `admin`, `general_manager`, or `night_auditor`

Channex OTA reviews can also arrive via `POST /channels/inbound/channex/reviews` (event `review`) without polling.


## iCal calendar polling worker

An optional standalone worker reuses `IcalService`; the HTTP API does not run its scheduler.
After migrations, start `node apps/api/dist/ical-worker.js` in a separate container using
`DATABASE_URL`, the PMS's `ICAL_SIGNING_SECRET`, and `ICAL_POLL_INTERVAL_MS`
(default 300000, range 60000–3600000). Production startup requires the calendar
secret so automatic imports recognise the API's signed export event identities.
It scans due active import feeds every 15 seconds, at most 25 per sweep, and retries
failed feeds on the next configured cadence. Changing a source URL makes the feed
due immediately while retaining last-good blocks. Export feeds are served by the API and
polled by the remote channel. No new public scheduler endpoint or staff password is required.

All import callers share a PostgreSQL feed-row lock. An overlapping manual sync returns
409; a scheduled attempt skips a locked or recently refreshed feed. Replacement takes
the reservation engine's room-type inventory lock. Invalid/unsupported/oversized/failed
responses preserve the previous busy blocks. Requests do not follow redirects, use
validated public DNS addresses for the connection, and cap time/body/events. This worker
uses the feed's physical-unit mapping and verifies unchanged signed export echoes.

Migration 0029 adds optional `roomId` to feeds. Map calendars for the same physical
unit to the same room, rather than inferring identity from matching dates or UIDs.
Unmapped imports retain legacy per-feed occupancy; import mappings can be edited.
Export mappings are immutable and signed into their URLs; old room-type URLs remain
valid. Unit exports include assigned reservations and mapped busy dates. Unassigned
reservations/unmapped imports are conservatively included until staff assigns/maps
them. Room-type exports publish only dates when the sellable type is exhausted.

Exports use privacy-safe, stable HMAC event UIDs. Import verifies those identities
before merging spans, and recognises legacy reservation UIDs only for actual scoped
PMS records. Providers that rewrite event UIDs still require fixture verification;
matching dates alone are never used to delete a possible external booking.

Feed reads expose `lastSyncAt` (latest attempt), `lastSuccessfulSyncAt`,
`consecutiveSyncFailures`, `lastSyncStatus` and a sanitised `lastSyncError`. Migration
0028 backfills last success only when the existing latest attempt was successful;
previous historical successes cannot be inferred for failed feeds.

Worker stdout is JSON: filter `ical_sync_failed`, `ical_sweep_failed` or
`ical_sweep_completed`. Events include `syncRunId`, `feedId`, `propertyId` and durations;
they omit source URLs, export tokens, event summaries and guest data.

`/tmp/haip-ical-worker-health.json` contains aggregate status, feed/failure/stale counts,
interval and heartbeat. `degraded` means a feed failed or its last success is older than
max(3 intervals, 10 minutes). `unavailable` means the worker could not perform its database
sweep. A container probe should fail for `unavailable` or a heartbeat older than two
minutes; a failed feed should alert operations without restarting a healthy worker.

Configure external retained logs/alerts separately. Docker health checks alone neither
send notifications nor prove live OTA delivery. Measure provider delays and prove unit
mapping with actual OTA fixtures before production use.

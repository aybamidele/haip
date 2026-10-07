# iCal calendar bridge

Many short-term rental and calendar workflows use **iCalendar (RFC 5545)** feeds — `.ics` URLs — to mirror availability and bookings.

## Current status

Staff routes are live under `/api/v1/ical`. Property-scoped routes require `propertyId`.

| Method | Path | Who |
|--------|------|-----|
| GET | `/api/v1/ical/feeds` | admin, revenue_manager |
| POST | `/api/v1/ical/feeds` | admin |
| GET | `/api/v1/ical/feeds/:id` | admin, revenue_manager |
| PATCH | `/api/v1/ical/feeds/:id` | admin |
| DELETE | `/api/v1/ical/feeds/:id` | admin |
| POST | `/api/v1/ical/feeds/:id/sync` | admin, revenue_manager |
| POST | `/api/v1/ical/feeds/:id/rotate-token` | admin |
| GET | `/api/v1/ical/feeds/:id/blocks` | admin, revenue_manager |
| GET | `/api/v1/ical/export.ics?token=` | token, no staff session |

Manual sync is available. A separately deployed HAIP calendar worker also checks due
imports every 15 seconds and refreshes each feed on a five-minute cadence. New feeds
and changed sources become due on the next sweep. The worker must share the API's
`ICAL_SIGNING_SECRET`; see the worker setup in the README. Without that worker,
imports require manual sync. Create and token rotation return the private export URL
once. The dashboard screen is Channels → iCal calendars. OpenAPI is at `/docs`.

## Why iCal

- **Open standard** — one HTTPS URL can be subscribed by multiple calendar clients.
- **STR hand-off** — some hosts sync a master calendar URL into OTAs that support iCal import (policies vary by channel; use HAIP’s channel integrations where certified API sync exists — see **[channels docs](../channels/)**).
- **Staff visibility** — a calendar client can show house-level blocks alongside personal calendars.

## What the routes do

| Direction | Behavior |
|-----------|----------|
| **Export feed** | Optional physical unit; otherwise room-type fully occupied dates. `GET /api/v1/ical/export.ics?token=` returns `text/calendar`. The token is the credential. |
| **Import feed** | Staff supply an HTTP(S) calendar URL. `POST /api/v1/ical/feeds/:id/sync?propertyId=` replaces that feed’s busy blocks. |
| **Refresh** | Manual sync or the separately configured worker. Failed downloads retain the last good busy snapshot. |

## Physical units and reservations

Set an import's optional `roomId` only when it identifies an active physical room in
that property and room type. Feeds mapped to the same room consume one inventory
unit; unmapped feeds retain their previous per-feed occupancy. Import mappings can
be edited. Export mappings are fixed after creation; create a new export to change
its physical scope. Existing pooled tokens without a room claim remain valid.

Unit exports include assigned reservations and mapped imported blocks. Unassigned
reservations and unmapped blocks are conservatively included in every unit export
until staff allocates/maps them. Room-type exports include only fully occupied spans.
Unchanged signed HAIP events returning through import are recognised as echoes;
rewritten external identities still require provider-specific verification.

Assignment, moves, check-in and assigned stay-date changes check overlapping
reservations and mapped active-import blocks under the shared inventory mutex.
Checkout is exclusive: a stay ending on another stay's arrival date does not overlap.
Cancelled, no-show and checked-out stays no longer occupy the room. A failed operation
returns a conflict before changing assignment or starting its check-in side effects.
Splitting guests also revalidates room-type availability for the additional stay.
The guard does not guess which physical unit an unmapped import represents, and does
not add automatic room allocation or eliminate external calendar delivery delays.

## Security notes

- Treat iCal URLs as secrets — anyone with the link can read booking windows.
- A failed sync keeps the previous blocks. The dashboard does not show the provider error text.

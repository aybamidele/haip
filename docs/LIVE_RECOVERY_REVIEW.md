# Reviewing dashboard live recovery

## What changed
The dashboard remembers its current property room across a transport reconnect. Each new handshake reads the current authentication token. Mounted queries refetch after reconnect because offline events are not replayed. Unmounting one Live indicator no longer removes another component’s listeners. Logout and failed token refresh disconnect the socket.

## Automated checks
Run `pnpm --filter @telivityhaip/dashboard test`, `pnpm --filter @telivityhaip/dashboard typecheck`, and `pnpm --filter @telivityhaip/dashboard build` after installing dependencies and building workspace packages. The recovery tests use a mounted React Query view, property switches, token refresh and independent socket consumers.

## Guided manual review
Use a disposable demo or an isolated authenticated preview with two properties and a synthetic reservation. Do not run against production.

1. Open Reservations for property A. Note the header property and current reservation status.
2. Use browser developer tools to go offline. Wait for the Live indicator to show disconnection.
3. In another online session, change that synthetic reservation. Restore the first browser’s connection. Its indicator should recover and its mounted list should show the changed reservation without a page reload.
4. Repeat while navigating from property A to property B during the outage. After reconnect, only B should be subscribed. Changes for A must not appear as B’s data.
5. With authentication enabled, let the normal token refresh run while disconnected. Restore connectivity. The refreshed token must allow reconnection without signing in again.
6. Navigate between views with the Live indicator, then repeat an event. Other mounted socket consumers must still receive updates.
7. Log out. The socket should disconnect and stop receiving property events.

Restore the synthetic reservation and close the extra session. Reconnect attempts remain bounded; this does not provide offline event replay or a durable event journal.

# Reviewing disabled staff enforcement

## What changed
Locally disabled or invited identities are denied at HTTP JWT validation, WebSocket verification, property-room joins and delivery to already connected subscribers. Effective permission queries return no grants for non-active staff. Status is evaluated globally for the identity, independently of its home property. Any non-active duplicate subject link denies access; subject linking precedes email fallback.

Active staff, property-scoped grants, existing unlinked-principal authorization and the explicit auth-disabled demo path remain supported. This does not revoke the identity provider’s tokens or undo requests already in progress.

## Automated review
Use a disposable migrated PostgreSQL database and set `OPERATIONS_TEST_DATABASE_URL` before running:

```sh
pnpm --filter @telivityhaip/api test src/modules/auth src/modules/events/events.gateway.spec.ts
pnpm --filter @telivityhaip/api typecheck
pnpm --filter @telivityhaip/api build
```

The database suite disables/reactivates the same linked identity and checks grants, duplicate subjects, invited users, email fallback, UUID spellings and non-UUID external subjects. Socket tests cover connection, existing subscriptions, both event types, property isolation and a status-lookup failure. JWT signature/client checks still run before local status evaluation. CI supplies the opt-in database URL.

## Guided authenticated manual review
This needs an isolated preview with authentication enabled. An auth-disabled demo cannot prove enforcement. Use an administrator and a disposable linked staff account; never disable the administrator you need for cleanup.

1. Sign in as the disposable staff member in browser A. Confirm an allowed property loads and a forbidden property is rejected. Keep the session and its socket open.
2. In administrator browser B, disable that exact locally linked account under Staff users. Do not log browser A out.
3. In A, request a protected page/API again with the retained session. It must be denied even if the token has not expired. A fresh socket connection/property join must also be rejected.
4. In B, change an owned synthetic reservation and create a synthetic staff notification. A’s old subscription must receive neither event; its socket should disconnect. An active colleague should still receive both.
5. Reactivate the disposable staff account. Its normal permissions and property restrictions should work again.
6. Repeat with an invited local account and a disabled email-linked account if those identity modes are used.

Restore the account to its original state, remove disposable identities as appropriate and revert synthetic operational changes. The check prevents subsequent authenticated requests and event delivery after committed status is observed; identity-provider token revocation remains a separate lifecycle operation.

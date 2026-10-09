# Reusing an existing guest in direct bookings

`POST /api/v1/booking-engine/linked-bookings?propertyId=<target UUID>` allows an authenticated integration to reuse an existing guest through the canonical booking engine. It requires a Keycloak JWT, target property membership and both `reservations.write` and `guests.write` at the target. The caller must also have source property membership and `guests.write` at the source.

The body contains the usual `BeCreateBookingDto` fields plus `guestId` and `sourcePropertyId`. HAIP reads the guest through its existing reservation-scoped, non-erased guest API before creating the reservation. The submitted email, name and phone must still match that guest. A stale contact causes rejection rather than a silent profile update. The reservation, pricing, restrictions, availability, DNR, folio, payment, confirmation and hold lifecycle remain the existing booking engine's responsibility.

The public `POST /booking-engine/book` route remains authenticated only by a low-trust publishable booking key. Its DTO does not accept either existing guest reference field. There is no global email lookup, automatic guest merge or new guest creation strategy for anonymous checkout. A trusted integration must establish guest ownership itself before selecting an existing record.

Guests are cross-property records, so a caller authorised at both properties can reuse a guest for a new property's reservation. Reading the source record still requires an existing source reservation association; the destination remains explicitly supplied and authorised. Existing reservations and operational guest fields are not rewritten by this route.

Verification lives in `linked-booking.controller.spec.ts`, the trusted reuse cases in `booking-engine.service.spec.ts`, and the JWT rejection in `auth/unauthenticated-routes.spec.ts`.

/** Explicitly gated, synthetic operational fixtures. Never run on production data. */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createHash } from 'node:crypto';
import { ROLE_DEFAULT_PERMISSIONS } from '@telivityhaip/shared/permissions-catalog';
import * as schema from './schema/index.js';
import { postgresOptionsFromEnv } from './postgres-options.js';

async function main() {
  if (process.env['HAIP_STAGING_FIXTURES'] !== 'true') throw new Error('Staging fixtures are disabled');
  const url = process.env['DATABASE_URL'];
  const adminSub = process.env['STAGING_ADMIN_SUB'];
  const readerSub = process.env['STAGING_READER_SUB'];
  const mediaBase = process.env['STAGING_MEDIA_BASE_URL'];
  const keyJson = process.env['STAGING_BOOKING_KEYS_JSON'];
  if (!url || !adminSub || !readerSub || !mediaBase || !keyJson) throw new Error('Missing staging fixture configuration');
  const keys: Record<string, string> = JSON.parse(keyJson);
  const client = postgres(url, postgresOptionsFromEnv());
  const db = drizzle(client, { schema });
  try {
    await db.transaction(async (tx) => {
      const roleId = '90000001-0000-4000-a000-000000000001';
      const adminId = '90000002-0000-4000-a000-000000000001';
      const readerId = '90000002-0000-4000-a000-000000000002';
      const readRoleId = '90000001-0000-4000-a000-000000000002';
      await tx.insert(schema.roles).values([
        { id: roleId, key: 'admin', name: 'Staging administrator', isSystem: true },
        { id: readRoleId, key: 'integration', name: 'Catalogue integration', isSystem: true },
      ]).onConflictDoNothing();
      await tx.insert(schema.users).values([
        { id: adminId, keycloakSub: adminSub, email: 'staging.operator@example.test', name: 'Staging operator', status: 'active' },
        { id: readerId, keycloakSub: readerSub, email: 'staging.integration@example.test', name: 'Staging catalogue integration', status: 'active' },
      ]).onConflictDoNothing();
      const fixtures = [
        { name: 'Garden Apartment', city: 'London', rate: '145.00', guests: 4, units: 1, description: 'A bright apartment with a private terrace, an open kitchen and room to settle in. Synthetic accommodation for staging tests; photographs are illustrative.' },
        { name: 'Canalside Loft', city: 'Manchester', rate: '125.00', guests: 2, units: 1, description: 'A light-filled loft with an inviting living space and a comfortable workspace. Synthetic accommodation for staging tests; photographs are illustrative.' },
        { name: 'Courtyard Studios', city: 'Bristol', rate: '95.00', guests: 2, units: 2, description: 'Two independently bookable studios, each with a kitchen and a quiet place to unwind. Synthetic accommodation for staging tests; photographs are illustrative.' },
      ];
      for (let i = 0; i < fixtures.length; i++) {
        const f = fixtures[i]!;
        const suffix = String(i + 1).padStart(12, '0');
        const propertyId = `10000001-0000-4000-a000-${suffix}`;
        const roomTypeId = `20000001-0000-4000-a000-${suffix}`;
        const rateId = `30000001-0000-4000-a000-${suffix}`;
        const policyId = `40000001-0000-4000-a000-${suffix}`;
        if (!keys[propertyId]) throw new Error('Missing fixture booking key');
        await tx.insert(schema.properties).values({ id: propertyId, name: f.name, code: `STAGING${i + 1}`, description: f.description, city: f.city, countryCode: 'GB', timezone: 'Europe/London', currencyCode: 'GBP', totalRooms: f.units, overbookingPercentage: 0, guestRegistrationRequired: false }).onConflictDoNothing();
        await tx.insert(schema.roomTypes).values({ id: roomTypeId, propertyId, name: i === 2 ? 'Entire studio' : 'Entire apartment', code: 'HOME', maxOccupancy: f.guests, defaultOccupancy: 2, bedType: 'king', bedCount: i === 0 ? 2 : 1, amenities: ['Wi-Fi', 'Kitchen', 'Workspace', 'Fresh linen', 'Self check-in'] }).onConflictDoNothing();
        for (let unit = 1; unit <= f.units; unit++) await tx.insert(schema.rooms).values({ id: `50000001-0000-4000-a000-${String((i + 1) * 10 + unit).padStart(12, '0')}`, propertyId, roomTypeId, number: `HOME-${unit}`, status: 'guest_ready' }).onConflictDoNothing();
        await tx.insert(schema.cancellationPolicies).values({ id: policyId, propertyId, name: 'Flexible staging policy', code: 'FLEX', description: 'Free cancellation before arrival. Simulated payments only.', freeCancelHoursBeforeArrival: 0, penaltyType: 'none', depositHandling: 'always_refund' }).onConflictDoNothing();
        await tx.insert(schema.ratePlans).values({ id: rateId, propertyId, roomTypeId, name: 'Flexible stay', code: 'FLEX', type: 'bar', baseAmount: f.rate, currencyCode: 'GBP', cancellationPolicyId: policyId, channelCodes: ['booking_engine'] }).onConflictDoNothing();
        await tx.insert(schema.bookingEngineConfig).values({ propertyId, isEnabled: true, autoConfirm: true, allowEnquiries: true, allowManualPayments: true, sellableRoomTypeIds: [roomTypeId], sellableRatePlanIds: [rateId], depositPolicy: { type: 'full', refundable: true }, bookingMode: 'instant', paymentMethodCollection: 'disabled' }).onConflictDoNothing();
        const rawKey = keys[propertyId]!;
        await tx.insert(schema.bookingEngineCredentials).values({ propertyId, label: 'Staging product', keyHash: createHash('sha256').update(rawKey).digest('hex'), keyPrefix: rawKey.slice(0, 16) }).onConflictDoNothing();
        for (const uid of [adminId, readerId]) await tx.insert(schema.userRoles).values({ propertyId, userId: uid, roleId: uid === adminId ? roleId : readRoleId }).onConflictDoNothing();
        for (const permissionKey of (ROLE_DEFAULT_PERMISSIONS['admin'] ?? [])) await tx.insert(schema.rolePermissions).values({ propertyId, roleId, permissionKey }).onConflictDoNothing();
        for (const permissionKey of ['reservations.read', 'rooms.read']) await tx.insert(schema.rolePermissions).values({ propertyId, roleId: readRoleId, permissionKey }).onConflictDoNothing();
        for (let photo = 1; photo <= 3; photo++) await tx.insert(schema.media).values({ id: `60000001-0000-4000-a000-${String((i + 1) * 10 + photo).padStart(12, '0')}`, propertyId, ownerType: 'property', ownerId: propertyId, url: `${mediaBase}/fixtures/home-${((i + photo - 1) % 3) + 1}.avif`, category: 'room', altText: 'Illustrative interior photograph for a synthetic staging property', caption: 'Illustrative photograph — dummy accommodation', sortOrder: photo - 1, isPrimary: photo === 1 }).onConflictDoNothing();
      }
    });
    console.log('Synthetic staging fixtures ready');
  } finally { await client.end(); }
}
main().catch(() => { console.error('Staging fixture setup failed'); process.exitCode = 1; });

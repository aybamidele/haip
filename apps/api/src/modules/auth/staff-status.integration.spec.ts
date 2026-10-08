import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@telivityhaip/database';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermissionsService } from './permissions.service';
import { JwtStrategy } from './jwt.strategy';

const url = process.env['OPERATIONS_TEST_DATABASE_URL'];
describe.skipIf(!url)('retained staff identity on PostgreSQL', () => {
  const client = postgres(url ?? 'postgresql://localhost/unavailable', { max: 3 });
  const db = drizzle(client, { schema });
  const permissions = new PermissionsService(db);
  let propertyId: string, userId: string, subject: string, roleId: string;
  let userIds: string[];
  beforeEach(async () => {
    propertyId = randomUUID(); userId = randomUUID(); subject = randomUUID(); roleId = randomUUID(); userIds = [userId];
    await db.insert(schema.properties).values({ id: propertyId, name: 'Synthetic staff scope', code: propertyId.slice(0, 20), countryCode: 'GB', timezone: 'UTC', currencyCode: 'GBP', totalRooms: 1 });
    await db.insert(schema.users).values({ id: userId, keycloakSub: subject, email: `${userId}@example.invalid`, name: 'Synthetic staff', status: 'active' });
    await db.insert(schema.roles).values({ id: roleId, propertyId, key: 'test', name: 'Synthetic role' });
    await db.insert(schema.rolePermissions).values({ propertyId, roleId, permissionKey: 'reservations.read' });
    await db.insert(schema.userRoles).values({ propertyId, roleId, userId });
  });
  afterEach(async () => {
    await db.delete(schema.userRoles).where(eq(schema.userRoles.propertyId, propertyId));
    await db.delete(schema.rolePermissions).where(eq(schema.rolePermissions.propertyId, propertyId));
    await db.delete(schema.roles).where(eq(schema.roles.id, roleId));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await db.delete(schema.properties).where(eq(schema.properties.id, propertyId));
  });
  afterAll(() => client.end());
  it('rejects the same validated JWT claims after disable and permits reactivation', async () => {
    const strategy = new JwtStrategy(new ConfigService({ KEYCLOAK_URL: 'http://keycloak.test', KEYCLOAK_REALM: 'haip', KEYCLOAK_CLIENT_ID: 'haip-api' }), permissions);
    const claims = { sub: subject, email: `${userId}@example.invalid`, azp: 'haip-api', realm_access: { roles: ['admin'] } };
    expect((await strategy.validate(claims)).sub).toBe(subject);
    await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, userId));
    await expect(strategy.validate(claims)).rejects.toBeInstanceOf(UnauthorizedException);
    await db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, userId));
    expect((await strategy.validate(claims)).sub).toBe(subject);
  });
  it('removes effective grants while disabled or invited and keeps property scope for active staff', async () => {
    expect(await permissions.getEffectivePermissions(userId, propertyId)).toEqual(['reservations.read']);
    expect(await permissions.getEffectivePermissions(userId, randomUUID())).toEqual([]);
    for (const status of ['disabled', 'invited'] as const) {
      await db.update(schema.users).set({ status }).where(eq(schema.users.id, userId));
      expect(await permissions.getEffectivePermissions(userId, propertyId)).toEqual([]);
      await expect(permissions.assertActiveIdentity({ sub: subject })).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });
  it('denies a non-active duplicate subject instead of selecting an arbitrary active match', async () => {
    const id = randomUUID(); userIds.push(id);
    await db.insert(schema.users).values({ id, keycloakSub: subject, email: `${id}@example.invalid`, name: 'Synthetic duplicate', status: 'disabled' });
    await expect(permissions.assertActiveIdentity({ sub: subject, email: `${userId}@example.invalid` })).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('checks email fallback but retains subject precedence and existing unlinked principal behavior', async () => {
    await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, userId));
    await expect(permissions.assertActiveIdentity({ sub: randomUUID(), email: `${userId}@example.invalid` })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(permissions.assertActiveIdentity({ sub: randomUUID(), email: 'unlinked@example.invalid' })).resolves.toBeUndefined();
    await db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, userId));
    const id = randomUUID(); userIds.push(id);
    await db.insert(schema.users).values({ id, email: `${id}@example.invalid`, name: 'Synthetic invited', status: 'invited' });
    await expect(permissions.assertActiveIdentity({ sub: subject, email: `${id}@example.invalid` })).resolves.toBeUndefined();
  });
  it('keeps signed non-UUID unlinked principals and checks their email fallback', async () => {
    await expect(permissions.assertActiveIdentity({ sub: 'external-staff-subject', email: 'unlinked@example.invalid' })).resolves.toBeUndefined();
    await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, userId));
    await expect(permissions.assertActiveIdentity({ sub: 'external-staff-subject', email: `${userId}@example.invalid` })).rejects.toBeInstanceOf(UnauthorizedException);
    for (const sub of [subject.replaceAll('-', ''), `{${subject}}`, subject.toUpperCase()]) {
      await expect(permissions.assertActiveIdentity({ sub })).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

});

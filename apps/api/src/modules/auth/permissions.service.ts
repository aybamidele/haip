import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { users, userRoles, rolePermissions } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';

/**
 * Resolves a request's effective permissions from the local RBAC tables.
 * Used by PermissionsGuard and the admin "effective permissions" endpoints.
 *
 * Lives in the auth module (not admin) so the globally-registered guard can
 * inject it without a circular module dependency.
 */
@Injectable()
export class PermissionsService {
  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  /** Find the local user for a JWT identity: by keycloakSub first, then email. */
  async findLocalUser(sub?: string, email?: string) {
    if (sub) {
      const [bySub] = await this.db
        .select()
        .from(users)
        .where(eq(users.keycloakSub, sub))
        .limit(1);
      if (bySub) return bySub;
    }
    if (email) {
      const [byEmail] = await this.db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (byEmail) return byEmail;
    }
    return null;
  }

  /** Status is global to the identity, not its home property or JWT lifetime. */
  async assertActiveIdentity(identity: { sub?: string; email?: string }): Promise<void> {
    // PostgreSQL UUID links also accept braced, undashed and upper-case UUIDs.
    // Non-UUID external subjects cannot match a link, but still use email fallback.
    const subject = identity.sub?.replace(/^\{(.*)\}$/, '$1').replaceAll('-', '');
    if (subject && /^[a-f\d]{32}$/i.test(subject)) {
      const linked = await this.db.select({ status: users.status }).from(users)
        .where(eq(users.keycloakSub, subject));
      if (linked.length > 0) {
        // Subject links are not unique. Any non-active match must deny rather
        // than selecting an arbitrary active row or falling through to email.
        if (linked.some((user: { status: string }) => user.status !== 'active')) {
          throw new UnauthorizedException('Staff account is not active');
        }
        return;
      }
    }
    if (identity.email) {
      const [linked] = await this.db.select({ status: users.status }).from(users)
        .where(eq(users.email, identity.email)).limit(1);
      if (linked && linked.status !== 'active') throw new UnauthorizedException('Staff account is not active');
    }
    // Unlinked JWT principals keep their existing authorization path. Local
    // permissions still require a linked, active account.
  }

  /**
   * Effective permission keys for a user at a property = the union of grants
   * across every role the user holds at that property. Grants are keyed by
   * (roleId, propertyId), so a global role's grants are still property-scoped.
   */
  async getEffectivePermissions(userId: string, propertyId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ permissionKey: rolePermissions.permissionKey })
      .from(userRoles)
      .innerJoin(users, and(eq(users.id, userRoles.userId), eq(users.status, 'active')))
      .innerJoin(
        rolePermissions,
        and(
          eq(rolePermissions.roleId, userRoles.roleId),
          eq(rolePermissions.propertyId, userRoles.propertyId),
        ),
      )
      .where(and(eq(userRoles.userId, userId), eq(userRoles.propertyId, propertyId)));
    return rows.map((r: { permissionKey: string }) => r.permissionKey);
  }
}

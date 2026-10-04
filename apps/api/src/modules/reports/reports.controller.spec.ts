import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { ReportsController } from './reports.controller';
import { PERMISSIONS_KEY } from '../auth/permissions.decorator';

describe('ReportsController authorization', () => {
  it('requires the reports.view permission on the controller', () => {
    // Financial/occupancy reports must not be readable by any authenticated user
    // (e.g. housekeeping) — PermissionsGuard enforces this metadata.
    const perms = Reflect.getMetadata(PERMISSIONS_KEY, ReportsController);
    expect(perms).toContain('reports.view');
  });
});


describe('portfolio report permission scope', () => {
  function setup(status = 'active') {
    const reports = { getPortfolioOccupancy: vi.fn().mockResolvedValue({}) };
    const resolver = { resolvePropertyIds: vi.fn().mockResolvedValue(['property-a', 'property-b']) };
    const config = { get: () => 'true' };
    const permissions = { findLocalUser: vi.fn().mockResolvedValue({ id: 'local-1', status }), getEffectivePermissions: vi.fn(async (_user: string, property: string) => property === 'property-a' ? ['reports.view'] : []) };
    return { controller: new ReportsController(reports as any, resolver as any, config as any, permissions as any), reports, permissions };
  }
  const user = { sub: 'staff-1', email: 'staff@example.test', name: 'Staff', roles: ['admin'], propertyIds: ['property-a', 'property-b'] };
  it('aggregates only properties with an explicit local report grant', async () => {
    const { controller, reports } = setup();
    await controller.getPortfolioOccupancy('2026-10-04', undefined, undefined, user);
    expect(reports.getPortfolioOccupancy).toHaveBeenCalledWith(['property-a'], '2026-10-04');
  });
  it('rejects a disabled account before reading reports', async () => {
    const { controller, reports } = setup('disabled');
    await expect(controller.getPortfolioOccupancy('2026-10-04', undefined, undefined, user)).rejects.toThrow(/Active local/);
    expect(reports.getPortfolioOccupancy).not.toHaveBeenCalled();
  });
  it('rejects a caller without any report grant', async () => {
    const { controller, permissions, reports } = setup(); permissions.getEffectivePermissions.mockResolvedValue([]);
    await expect(controller.getPortfolioOccupancy('2026-10-04', undefined, undefined, user)).rejects.toThrow(/No report permissions/);
    expect(reports.getPortfolioOccupancy).not.toHaveBeenCalled();
  });
});

import { generateKeyPairSync } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { WsAuthService } from './ws-auth.service';
import { PermissionsService } from './permissions.service';
const keys = vi.hoisted(() => ({ publicKey: '' }));
vi.mock('jwks-rsa', () => ({ default: () => ({ getSigningKey: (_kid: string, callback: (error: null, key: { getPublicKey(): string }) => void) => callback(null, { getPublicKey: () => keys.publicKey }) }) }));
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
keys.publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const config = new ConfigService({ KEYCLOAK_URL: 'http://keycloak.test', KEYCLOAK_REALM: 'haip', KEYCLOAK_CLIENT_ID: 'haip-api' });
function token(overrides = {}) {
  return jwt.sign({ sub: 'synthetic-sub', email: 'staff@example.invalid', azp: 'haip-api', realm_access: { roles: ['admin'] }, ...overrides }, pair.privateKey, { algorithm: 'RS256', keyid: 'synthetic-key', issuer: 'http://keycloak.test/realms/haip', audience: 'haip-api', expiresIn: 600 });
}
describe('WebSocket JWT and local staff lifecycle', () => {
  it('rejects the same signed unexpired token after a local disable', async () => {
    let active = true;
    const assertActiveIdentity = vi.fn(async () => { if (!active) throw new UnauthorizedException('Staff account is not active'); });
    const service = new WsAuthService(config, { assertActiveIdentity } as unknown as PermissionsService);
    const retained = token();
    expect((await service.verify(retained)).sub).toBe('synthetic-sub'); active = false;
    await expect(service.verify(retained)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(assertActiveIdentity).toHaveBeenCalledWith(expect.objectContaining({ sub: 'synthetic-sub' }));
  });
  it('keeps signature and client checks before local status lookup', async () => {
    const assertActiveIdentity = vi.fn().mockResolvedValue(undefined);
    const service = new WsAuthService(config, { assertActiveIdentity } as unknown as PermissionsService);
    await expect(service.verify(token({ azp: 'wrong-client' }))).rejects.toThrow('azp mismatch');
    await expect(service.verify('invalid.jwt.value')).rejects.toThrow();
    expect(assertActiveIdentity).not.toHaveBeenCalled();
  });
});

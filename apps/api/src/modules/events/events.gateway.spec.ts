import { ConfigService } from '@nestjs/config';
import type { Server, Socket } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';
import { EventsGateway } from './events.gateway';
import { WsAuthService } from '../auth/ws-auth.service';
import type { AuthUser } from '../auth/current-user.decorator';
function socket(sub: string, propertyIds = ['property-a']) {
  return { id: sub, data: { user: { sub, email: `${sub}@example.invalid`, name: sub, roles: [], propertyIds } as AuthUser }, handshake: { auth: { token: 'retained-token' } }, emit: vi.fn(), disconnect: vi.fn(), join: vi.fn() };
}
function setup(auth = true) {
  const disabled = new Set<string>();
  const assertActiveIdentity = vi.fn(async (user: AuthUser) => { if (disabled.has(user.sub)) throw new Error('disabled'); });
  const verify = vi.fn(async () => { const user = socket('staff-a').data.user; await assertActiveIdentity(user); return user; });
  const clients = [socket('staff-a'), socket('staff-b')];
  const roomEmit = vi.fn(); const fetchSockets = vi.fn(async () => clients);
  const gateway = new EventsGateway({ verify, assertActiveIdentity } as unknown as WsAuthService, new ConfigService({ AUTH_ENABLED: String(auth) }));
  gateway.server = { in: vi.fn(() => ({ fetchSockets })), to: vi.fn(() => ({ emit: roomEmit })) } as unknown as Server;
  return { gateway, disabled, assertActiveIdentity, clients, roomEmit, fetchSockets };
}
describe('local staff status at socket entry and delivery boundaries', () => {
  it('rejects a retained token during connection and disables an already authenticated join', async () => {
    const { gateway, disabled, clients } = setup(); disabled.add('staff-a');
    await gateway.handleConnection(clients[0] as unknown as Socket); expect(clients[0].disconnect).toHaveBeenCalledWith(true);
    clients[0].disconnect.mockClear();
    await gateway.handleJoinProperty(clients[0] as unknown as Socket, { propertyId: 'property-a' });
    expect(clients[0].join).not.toHaveBeenCalled(); expect(clients[0].disconnect).toHaveBeenCalledWith(true);
  });
  it.each(['pmsEvent', 'staffNotification'])('stops %s delivery to disabled existing subscribers while active colleagues still receive', async event => {
    const { gateway, disabled, clients } = setup();
    await gateway.handleJoinProperty(clients[0] as unknown as Socket, { propertyId: 'property-a' }); expect(clients[0].join).toHaveBeenCalled();
    disabled.add('staff-a');
    if (event === 'pmsEvent') await gateway.broadcastToProperty('property-a', 'reservation.created', { id: 'synthetic' });
    else await gateway.broadcastStaffNotification('property-a', { title: 'Synthetic' });
    expect(clients[0].emit).not.toHaveBeenCalled(); expect(clients[0].disconnect).toHaveBeenCalledWith(true);
    expect(clients[1].emit).toHaveBeenCalledWith(event, expect.any(Object));
  });
  it('retains property isolation and fails closed on unavailable account status', async () => {
    const { gateway, clients, assertActiveIdentity } = setup(); clients[0].data.user.propertyIds = ['property-b'];
    assertActiveIdentity.mockRejectedValue(new Error('database unavailable'));
    await gateway.broadcastToProperty('property-a', 'reservation.created', {});
    for (const client of clients) { expect(client.emit).not.toHaveBeenCalled(); expect(client.disconnect).toHaveBeenCalledWith(true); }
  });
  it('checks a shared identity once per broadcast, not once per open tab', async () => {
    const { gateway, clients, assertActiveIdentity } = setup(); clients[1].data.user = clients[0].data.user;
    await gateway.broadcastToProperty('property-a', 'reservation.created', {}); expect(assertActiveIdentity).toHaveBeenCalledOnce();
    for (const client of clients) expect(client.emit).toHaveBeenCalledOnce();
  });
  it('preserves the explicit auth-disabled demo path', async () => {
    const { gateway, clients, roomEmit, assertActiveIdentity, fetchSockets } = setup(false);
    await gateway.handleJoinProperty(clients[0] as unknown as Socket, { propertyId: 'property-a' });
    await gateway.broadcastToProperty('property-a', 'reservation.created', {}); await gateway.broadcastStaffNotification('property-a', {});
    expect(clients[0].join).toHaveBeenCalledWith('property:property-a'); expect(roomEmit).toHaveBeenCalledTimes(2);
    expect(assertActiveIdentity).not.toHaveBeenCalled(); expect(fetchSockets).not.toHaveBeenCalled();
  });
});

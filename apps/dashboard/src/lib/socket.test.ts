import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ io: vi.fn(), auth: { authenticated: true, token: 'old-token' } }));
vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('./keycloak', () => ({ AUTH_ENABLED: true, keycloak: mocks.auth }));

async function setup() {
  const listeners = new Map<string, () => void>();
  const socket = { connected: false, on: vi.fn((event: string, fn: () => void) => listeners.set(event, fn)),
    emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() };
  mocks.io.mockReturnValue(socket);
  const api = await import('./socket');
  return { api, socket, connect: () => { socket.connected = true; listeners.get('connect')?.(); } };
}
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.auth.authenticated = true; mocks.auth.token = 'old-token'; });
describe('live property recovery', () => {
  it('restarts a disconnected socket and uses refreshed credentials on every handshake', async () => {
    const { api, socket } = await setup();
    api.getSocket(); mocks.auth.token = 'new-token'; api.reconnectSocket();
    expect(socket.connect).toHaveBeenCalledOnce(); expect(socket.disconnect).not.toHaveBeenCalled();
    const callback = vi.fn(); mocks.io.mock.calls[0][1].auth(callback);
    expect(callback).toHaveBeenCalledWith({ token: 'new-token' });
  });
  it('restarts a connected socket and rejoins the property on every connect', async () => {
    const { api, socket, connect } = await setup();
    api.joinPropertyRoom('a'); expect(socket.emit).not.toHaveBeenCalled(); connect();
    expect(socket.emit).toHaveBeenLastCalledWith('joinProperty', { propertyId: 'a' });
    api.reconnectSocket(); expect(socket.disconnect).toHaveBeenCalledOnce(); connect();
    expect(socket.emit.mock.calls.filter(([event]) => event === 'joinProperty')).toHaveLength(2);
    expect(socket.on).toHaveBeenCalledTimes(1);
  });
  it('joins only the latest property after switching while offline, never buffered old scopes', async () => {
    const { api, socket, connect } = await setup();
    api.joinPropertyRoom('a'); api.leavePropertyRoom('a'); api.joinPropertyRoom('b'); connect();
    expect(socket.emit).toHaveBeenCalledOnce();
    expect(socket.emit).toHaveBeenCalledWith('joinProperty', { propertyId: 'b' });
  });
  it('does not rejoin after portfolio selection', async () => {
    const { api, socket, connect } = await setup();
    api.joinPropertyRoom('a'); api.leavePropertyRoom('a'); connect(); expect(socket.emit).not.toHaveBeenCalled();
  });
  it('stops retries/subscriptions on logout and does not reconnect an invalid session', async () => {
    const { api, socket, connect } = await setup();
    api.joinPropertyRoom('a'); api.disconnectSocket();
    mocks.auth.authenticated = false; mocks.auth.token = ''; api.reconnectSocket();
    expect(socket.connect).toHaveBeenCalledOnce(); connect(); expect(socket.emit).not.toHaveBeenCalled();
  });
});

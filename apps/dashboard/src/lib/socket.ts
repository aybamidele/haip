import { io, type Socket } from 'socket.io-client';
import { AUTH_ENABLED, keycloak } from './keycloak';

let socket: Socket | null = null;
let activePropertyId: string | null = null;

function socketAuthPayload(): Record<string, string> {
  if (AUTH_ENABLED && keycloak.token) {
    return { token: keycloak.token };
  }
  return {};
}

export function getSocket(): Socket {
  if (!socket) {
    socket = io('/', {
      transports: ['websocket', 'polling'],
      autoConnect: false,
      auth: (callback) => callback(socketAuthPayload()),
      reconnectionAttempts: 5,
    });
    socket.on('connect', () => {
      if (activePropertyId) socket?.emit('joinProperty', { propertyId: activePropertyId });
    });
  }
  return socket;
}

/** Reconnect with a fresh JWT after Keycloak token refresh. */
export function reconnectSocket() {
  const s = getSocket();
  if (AUTH_ENABLED && (!keycloak.authenticated || !keycloak.token)) return;
  if (s.connected) s.disconnect();
  s.connect();
}

export function joinPropertyRoom(propertyId: string) {
  const s = getSocket();
  activePropertyId = propertyId;
  if (AUTH_ENABLED && (!keycloak.authenticated || !keycloak.token)) return;
  if (s.connected) s.emit('joinProperty', { propertyId });
  else s.connect();
}

export function leavePropertyRoom(propertyId: string) {
  const s = getSocket();
  if (activePropertyId === propertyId) activePropertyId = null;
  if (s.connected) s.emit('leaveProperty', { propertyId });
}

/** Explicit disconnect stops Socket.IO retries and clears the property subscription. */
export function disconnectSocket() {
  activePropertyId = null;
  socket?.disconnect();
}

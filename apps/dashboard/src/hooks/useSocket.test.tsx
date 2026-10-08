import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useSocket } from './useSocket';
const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  return { listeners, socket: { connected: false,
    on: vi.fn((name: string, fn: () => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); }),
    off: vi.fn((name: string, fn: () => void) => listeners.get(name)?.delete(fn)) } };
});
vi.mock('../lib/socket', () => ({ getSocket: () => mocks.socket }));
it('unmounting one Live indicator preserves other consumers and property recovery listeners', () => {
  const propertyRecovery = vi.fn(); mocks.socket.on('connect', propertyRecovery);
  const first = renderHook(useSocket), second = renderHook(useSocket);
  first.unmount();
  act(() => { mocks.listeners.get('connect')?.forEach(fn => fn()); });
  expect(propertyRecovery).toHaveBeenCalledOnce(); expect(second.result.current.connected).toBe(true);
  expect(mocks.socket.off).toHaveBeenCalledWith('connect', expect.any(Function));
  second.unmount();
});

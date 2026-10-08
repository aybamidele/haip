import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useRealtimeInvalidation } from './useRealtimeInvalidation';
const socket = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return { handlers, on: (event: string, fn: (...args: unknown[]) => void) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event)!.add(fn); }, off: (event: string, fn: (...args: unknown[]) => void) => { handlers.get(event)?.delete(fn); } };
});
vi.mock('../lib/socket', () => ({ getSocket: () => socket }));
vi.mock('../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: 'property-a', isPortfolioMode: false }) }));
it('refetches a mounted view after missed offline changes and unregisters only its own handlers', async () => {
  let value = 'before offline change';
  const read = vi.fn(async () => value);
  function View() { useRealtimeInvalidation(); const query = useQuery({ queryKey: ['reservations', 'property-a'], queryFn: read }); return <p>{query.data}</p>; }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const unrelated = vi.fn(); socket.on('connect', unrelated);
  const view = render(<QueryClientProvider client={client}><View /></QueryClientProvider>);
  expect(await screen.findByText('before offline change')).toBeInTheDocument(); value = 'after offline change';
  await act(async () => { for (const handler of socket.handlers.get('connect') ?? []) handler(); });
  await waitFor(() => expect(screen.getByText('after offline change')).toBeInTheDocument());
  expect(read).toHaveBeenCalledTimes(2); view.unmount();
  expect(socket.handlers.get('connect')).toEqual(new Set([unrelated])); socket.off('connect', unrelated);
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import StayDateEditor from './StayDateEditor';
const mocks = vi.hoisted(() => ({ patch: vi.fn(), allowed: true }));
vi.mock('../../lib/api', () => ({ api: { patch: mocks.patch } }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => mocks.allowed }) }));
function setup(overrides: Partial<Parameters<typeof StayDateEditor>[0]> = {}) {
  const onSaved = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <StayDateEditor reservationId="stay-a" propertyId="property-a" status="confirmed" source="direct" arrivalDate="2027-11-01" departureDate="2027-11-04" onSaved={onSaved} {...overrides} />
  </QueryClientProvider>); return onSaved;
}
beforeEach(() => { vi.clearAllMocks(); mocks.allowed = true; mocks.patch.mockResolvedValue({ data: {} }); });
it('saves dates through the property-scoped API without submitting or recomputing money', async () => {
  const onSaved = setup(); await userEvent.click(screen.getByRole('button', { name: 'Edit stay dates' }));
  expect(screen.getByLabelText('Arrival')).toHaveFocus();
  fireEvent.change(screen.getByLabelText('Departure'), { target: { value: '2027-11-05' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save dates' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ arrivalDate: '2027-11-01', departureDate: '2027-11-05' }));
  expect(mocks.patch).toHaveBeenCalledWith('/v1/reservations/stay-a', { arrivalDate: '2027-11-01', departureDate: '2027-11-05' }, { params: { propertyId: 'property-a' }, skipErrorToast: true });
  expect(await screen.findByRole('status')).toHaveTextContent('Stay dates updated');
});
it('rejects unchanged, empty and reversed date selections before writing', async () => {
  setup(); await userEvent.click(screen.getByRole('button', { name: 'Edit stay dates' }));
  expect(screen.getByRole('button', { name: 'Save dates' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Departure'), { target: { value: '2027-10-31' } });
  expect(screen.getByRole('button', { name: 'Save dates' })).toBeDisabled();
  expect(screen.getByLabelText('Departure')).toHaveAttribute('aria-invalid', 'true');
  fireEvent.change(screen.getByLabelText('Arrival'), { target: { value: '' } });
  expect(mocks.patch).not.toHaveBeenCalled();
});
it.each(['Assigned room overlaps another reservation', 'A Stay Amendment is required before changing accepted pricing'])('retains draft dates and current stay after server rejection: %s', async message => {
  const onSaved = setup(); mocks.patch.mockRejectedValueOnce({ response: { data: { message } } });
  await userEvent.click(screen.getByRole('button', { name: 'Edit stay dates' }));
  fireEvent.change(screen.getByLabelText('Departure'), { target: { value: '2027-11-05' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save dates' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.getByLabelText('Departure')).toHaveValue('2027-11-05'); expect(onSaved).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Save dates' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
});
it('Escape discards the draft and returns focus without writing', async () => {
  setup(); const trigger = screen.getByRole('button', { name: 'Edit stay dates' });
  await userEvent.click(trigger); await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit stay dates' })).toHaveFocus()); expect(mocks.patch).not.toHaveBeenCalled();
});
it('does not offer mutation to read-only roles', () => { mocks.allowed = false; setup(); expect(screen.queryByRole('button')).not.toBeInTheDocument(); });
it.each(['cancelled', 'checked_out', 'no_show'])('does not offer date editing for %s', status => { setup({ status }); expect(screen.queryByRole('button')).not.toBeInTheDocument(); });
it('does not offer the direct-stay editor for an OTA stay', () => { setup({ source: 'ota' }); expect(screen.queryByRole('button')).not.toBeInTheDocument(); });

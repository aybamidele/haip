import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import FolioInvoices from './FolioInvoices';
import { api } from '../../lib/api';

let manage = true;
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: (permission: string) => permission !== 'folios.manage' || manage }) }));
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const folio = { id: 'folio-1', status: 'open', balance: '100.00', currencyCode: 'GBP' };
const draft = { id: 'invoice-1', documentId: 'doc-1', status: 'draft', amount: '100.00', currencyCode: 'GBP', billingName: 'Synthetic Guest', billingEmail: 'synthetic@example.invalid', dueDays: '14', createdAt: '2026-10-10T10:00:00Z' };
let rows: typeof draft[];
let documents: { id: string; documentType: string; status: string }[];

function mount(props: Partial<React.ComponentProps<typeof FolioInvoices>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><FolioInvoices folio={folio} propertyId="property-1" configured mode="test" {...props} /></QueryClientProvider>);
}

beforeEach(() => {
  manage = true; rows = []; documents = []; vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async url => ({ data: url.endsWith('fiscal-documents') ? documents : rows }));
  vi.mocked(api.post).mockImplementation(async url => {
    if (url.endsWith('fiscal-documents')) { const doc = { id: 'doc-1', documentType: 'invoice', status: 'requested' }; documents = [doc]; return { data: doc }; }
    if (url === '/v1/stripe-invoices') { rows = [draft]; return { data: draft }; }
    rows = rows.map(row => ({ ...row, status: url.endsWith('/send') ? 'open' : 'void' }));
    return { data: rows[0] };
  });
});

describe('folio hosted invoices', () => {
  it('creates a property-scoped draft from a fiscal document without sending it', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Create invoice' }));
    expect(await screen.findByText('Draft')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/v1/stripe-invoices', { propertyId: 'property-1', folioId: 'folio-1', documentId: 'doc-1', dueDays: 14 }, expect.objectContaining({ params: { propertyId: 'property-1' } }));
    expect(api.get).toHaveBeenCalledWith('/v1/stripe-invoices', expect.objectContaining({ params: { propertyId: 'property-1', folioId: 'folio-1' } }));
    expect(vi.mocked(api.post).mock.calls.some(([url]) => url.endsWith('/send'))).toBe(false);
    expect(screen.getByText(/does not deliver invoice emails/)).toBeInTheDocument();
  });

  it('reuses a requested document after an uncertain creation response', async () => {
    documents = [{ id: 'existing-doc', documentType: 'invoice', status: 'requested' }];
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Create invoice' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/stripe-invoices', expect.objectContaining({ documentId: 'existing-doc' }), expect.anything()));
    expect(vi.mocked(api.post).mock.calls.some(([url]) => url.endsWith('fiscal-documents'))).toBe(false);
  });

  it('recovers an incomplete attempt with its persisted terms rather than creating another document', async () => {
    rows = [{ ...draft, status: 'creating', dueDays: '7' }];
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Retry draft creation' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/stripe-invoices', expect.objectContaining({ documentId: 'doc-1', dueDays: 7 }), expect.anything()));
    expect(vi.mocked(api.post).mock.calls.some(([url]) => url.endsWith('fiscal-documents'))).toBe(false);
  });

  it('requires explicit billing-contact review before finalization and then shows awaiting payment', async () => {
    rows = [draft]; mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Send invoice' }));
    expect(screen.getByText(/Finalize.*synthetic@example.invalid/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByText('Awaiting payment')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/v1/stripe-invoices/invoice-1/send', {}, expect.objectContaining({ params: { propertyId: 'property-1' } }));
    expect(screen.queryByRole('button', { name: 'Create invoice' })).not.toBeInTheDocument();
  });

  it('requires confirmation before voiding collection', async () => {
    rows = [{ ...draft, status: 'open' }]; mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Void invoice' }));
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm void' }));
    expect(await screen.findByText('Voided')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/v1/stripe-invoices/invoice-1/void', {}, expect.objectContaining({ params: { propertyId: 'property-1' } }));
  });

  it('keeps failure visible and refreshes before permitting another attempt', async () => {
    rows = [draft]; vi.mocked(api.post).mockRejectedValue(new Error('Network interrupted')); mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Send invoice' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Refresh status before retrying');
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('shows paid history and safe links for read-only staff without collection controls', async () => {
    manage = false; rows = [{ ...draft, status: 'paid', hostedUrl: 'https://invoice.stripe.com/i/test' } as typeof draft]; mount();
    expect(await screen.findByText('Paid')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View invoice' })).toHaveAttribute('href', 'https://invoice.stripe.com/i/test');
    expect(screen.getByText(/Refunds appear in Payments/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create invoice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send invoice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void invoice' })).not.toBeInTheDocument();
  });

  it('does not offer an unsafe URL, unavailable gateway or zero-balance collection', async () => {
    rows = [{ ...draft, status: 'paid', hostedUrl: 'javascript:alert(1)' } as typeof draft];
    mount({ configured: false, folio: { ...folio, balance: '0.00' } });
    expect(await screen.findByText('Paid')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View invoice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create invoice' })).not.toBeInTheDocument();
  });
});

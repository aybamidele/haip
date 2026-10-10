import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ExternalLink, FileText, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import { useAuth } from '../../context/AuthContext';
import StatusBadge from '../ui/StatusBadge';

interface Invoice {
  id: string;
  documentId: string;
  amount: string;
  currencyCode: string;
  status: string;
  billingName: string;
  billingEmail: string;
  dueDays: string;
  hostedUrl?: string | null;
  createdAt: string;
}

interface FiscalDocument {
  id: string;
  documentType: string;
  status: string;
}

const COLLECTIBLE = new Set(['creating', 'draft', 'open', 'uncollectible']);
const buttonClass = 'min-h-10 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-telivity-slate hover:bg-telivity-light-grey focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-telivity-teal disabled:cursor-not-allowed disabled:opacity-50';
const primaryClass = 'min-h-10 rounded-lg bg-telivity-teal px-3 py-2 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-telivity-teal disabled:cursor-not-allowed disabled:opacity-50';

function hostedLink(value?: string | null) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'invoice.stripe.com' ? url.href : undefined;
  } catch { return undefined; }
}

export default function FolioInvoices({ folio, propertyId, configured, mode }: {
  folio: { id: string; status: string; balance: number | string; currencyCode?: string };
  propertyId: string;
  configured: boolean;
  mode?: string;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const dueId = useId();
  const [dueDays, setDueDays] = useState('14');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<{ invoice: Invoice; action: 'send' | 'void' } | null>(null);
  const canRead = hasPermission('folios.read');
  const canManage = hasPermission('folios.manage');
  const params = { propertyId, folioId: folio.id };
  const key = ['folio-invoices', propertyId, folio.id];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<Invoice[]>('/v1/stripe-invoices', { params, skipErrorToast: true }).then(r => r.data),
    enabled: canRead,
    refetchInterval: q => q.state.data?.some(row => COLLECTIBLE.has(row.status)) ? 5000 : false,
    retry: false,
  });
  const invoices = query.data ?? [];
  const active = invoices.find(row => COLLECTIBLE.has(row.status));
  const statuses = invoices.map(row => `${row.id}:${row.status}`).join(',');
  useEffect(() => {
    // The signed provider callback changes invoice state; refresh the PMS ledger alongside it.
    queryClient.invalidateQueries({ queryKey: ['folios', propertyId, folio.id] });
    queryClient.invalidateQueries({ queryKey: ['payments', 'folio', propertyId, folio.id] });
  }, [statuses, propertyId, folio.id, queryClient]);

  const changed = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({ queryKey: ['folios', propertyId, folio.id] }),
      queryClient.invalidateQueries({ queryKey: ['payments', 'folio', propertyId, folio.id] }),
    ]);
  };
  const failed = () => { setError(t('folioInvoices.operationFailed')); void changed(); };
  const create = useMutation({
    mutationFn: async () => {
      // Recover the persisted attempt after an uncertain response or a page reload.
      const current = (await api.get<Invoice[]>('/v1/stripe-invoices', { params, skipErrorToast: true })).data;
      const existing = current.find(row => COLLECTIBLE.has(row.status));
      let documentId: string;
      let days = Number(dueDays);
      if (existing) {
        if (existing.status !== 'creating') throw new Error('Existing collectible invoice');
        documentId = existing.documentId;
        days = Number(existing.dueDays);
      } else {
        const documents = (await api.get<FiscalDocument[]>(`/v1/folios/${folio.id}/fiscal-documents`, { params: { propertyId }, skipErrorToast: true })).data;
        const requested = documents.find(doc => doc.documentType === 'invoice' && doc.status === 'requested' && !current.some(row => row.documentId === doc.id));
        documentId = requested?.id ?? (await api.post<FiscalDocument>(`/v1/folios/${folio.id}/fiscal-documents`, { propertyId, documentType: 'invoice' }, { params: { propertyId }, skipErrorToast: true })).data.id;
      }
      return api.post<Invoice>('/v1/stripe-invoices', { propertyId, folioId: folio.id, documentId, dueDays: days }, { params: { propertyId }, skipErrorToast: true });
    },
    onSuccess: changed,
    onError: failed,
  });
  const action = useMutation({
    mutationFn: ({ invoice, action: operation }: { invoice: Invoice; action: 'send' | 'void' }) =>
      api.post(`/v1/stripe-invoices/${invoice.id}/${operation}`, {}, { params: { propertyId }, skipErrorToast: true }),
    onSuccess: async () => { setConfirmation(null); await changed(); },
    onError: failed,
  });
  const busy = create.isPending || action.isPending;
  const validDays = Number.isInteger(Number(dueDays)) && Number(dueDays) >= 1 && Number(dueDays) <= 365;

  if (!canRead) return null;

  return (
    <section aria-label={t('folioInvoices.title')} className="bg-white rounded-xl shadow-sm p-5 mb-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <h2 className="text-base font-semibold text-telivity-navy flex items-center gap-2"><FileText size={18} aria-hidden="true" />{t('folioInvoices.title')}</h2>
        <button type="button" className={buttonClass} disabled={busy || query.isFetching} onClick={() => { setError(''); void changed(); }}>
          <RefreshCw size={14} className="inline mr-2" aria-hidden="true" />{t('folioInvoices.refresh')}
        </button>
      </div>
      <p className="text-sm text-telivity-slate mb-3">{t('folioInvoices.hint')}</p>
      {mode === 'test' ? <p className="text-sm text-telivity-slate mb-4">{t('folioInvoices.sandbox')}</p> : null}
      {!configured ? <p className="text-sm text-telivity-slate mb-3">{t('folioInvoices.notConfigured')}</p> : null}
      {query.isPending ? <p role="status" className="text-sm text-telivity-slate">{t('common.loading')}</p> : null}
      {query.isError ? <p role="alert" className="text-sm text-red-700">{t('folioInvoices.loadFailed')}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700 mb-3">{error}</p> : null}
      {query.isSuccess && invoices.length === 0 ? <p className="text-sm text-telivity-slate mb-4">{t('folioInvoices.empty')}</p> : null}

      {query.isSuccess && canManage && configured && !active && folio.status === 'open' && Number(folio.balance) > 0 ? (
        <form className="flex items-end flex-wrap gap-3 mb-4" aria-busy={create.isPending} onSubmit={event => { event.preventDefault(); if (!validDays || busy) return; setError(''); create.mutate(); }}>
          <div>
            <label htmlFor={dueId} className="block text-sm font-medium text-telivity-slate mb-1">{t('folioInvoices.dueDays')}</label>
            <input id={dueId} type="number" min="1" max="365" step="1" required value={dueDays} onChange={event => setDueDays(event.target.value)} className="w-28 min-h-10 rounded-lg border border-gray-200 px-3 py-2 text-sm" />
          </div>
          <button type="submit" disabled={!validDays || busy} className={primaryClass}>{create.isPending ? t('folioInvoices.creating') : t('folioInvoices.create')}</button>
          <p className="text-sm text-telivity-slate py-2">{t('folioInvoices.balance', { amount: formatMoney(Number(folio.balance), folio.currencyCode) })}</p>
        </form>
      ) : null}
      {query.isSuccess && !active && Number(folio.balance) <= 0 ? <p className="text-sm text-telivity-slate">{t('folioInvoices.noBalance')}</p> : null}
      <ul className="divide-y divide-gray-100">
        {invoices.map(invoice => {
          const url = hostedLink(invoice.hostedUrl);
          const selected = confirmation?.invoice.id === invoice.id && confirmation.invoice.status === invoice.status;
          return (
            <li key={invoice.id} className="py-4">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div className="min-w-0">
                  <div className="flex items-center flex-wrap gap-3 mb-1">
                    <span className="text-base font-semibold text-telivity-navy tabular-nums">{formatMoney(Number(invoice.amount), invoice.currencyCode)}</span>
                    <StatusBadge status={invoice.status === 'paid' ? 'success' : invoice.status === 'void' ? 'completed' : 'pending'} label={t(`folioInvoices.status.${invoice.status}`, { defaultValue: invoice.status })} />
                  </div>
                  <p className="text-sm text-telivity-slate break-all">{invoice.billingName} · {invoice.billingEmail}</p>
                  <p className="text-sm text-telivity-slate mt-1">{t('folioInvoices.terms', { days: invoice.dueDays })}</p>
                </div>
                <div className="flex items-center flex-wrap gap-2">
                  {url ? <a href={url} target="_blank" rel="noopener noreferrer" className={`${buttonClass} inline-flex items-center gap-2`}>{t('folioInvoices.view')}<ExternalLink size={14} aria-hidden="true" /></a> : null}
                  {canManage && configured && invoice.status === 'creating' ? <button type="button" disabled={busy} className={buttonClass} onClick={() => { setError(''); create.mutate(); }}>{t('folioInvoices.retry')}</button> : null}
                  {canManage && configured && invoice.status === 'draft' ? <button type="button" disabled={busy} className={primaryClass} onClick={() => { setError(''); setConfirmation({ invoice, action: 'send' }); }}>{t('folioInvoices.send')}</button> : null}
                  {canManage && configured && ['draft', 'open', 'uncollectible'].includes(invoice.status) ? <button type="button" disabled={busy} className={buttonClass} onClick={() => { setError(''); setConfirmation({ invoice, action: 'void' }); }}>{t('folioInvoices.void')}</button> : null}
                </div>
              </div>
              {invoice.status === 'creating' ? <p className="text-sm text-telivity-slate mt-2">{t('folioInvoices.retryHint')}</p> : null}
              {invoice.status === 'paid' ? <p className="text-sm text-telivity-slate mt-2">{t('folioInvoices.paidHint')}</p> : null}
              {selected ? (
                <div role="group" aria-label={t('folioInvoices.confirmation')} className="mt-4 space-y-3">
                  <p className="text-sm text-telivity-navy">{confirmation.action === 'send' ? t('folioInvoices.sendConfirm', { amount: formatMoney(Number(invoice.amount), invoice.currencyCode), email: invoice.billingEmail }) : t('folioInvoices.voidConfirm')}</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={primaryClass} disabled={busy} onClick={() => { setError(''); action.mutate(confirmation); }}>{busy ? t('common.loading') : confirmation.action === 'send' ? t('folioInvoices.confirmSend') : t('folioInvoices.confirmVoid')}</button>
                    <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirmation(null)}>{t('common.cancel')}</button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';

interface StayDates { arrivalDate: string; departureDate: string }
interface Props extends StayDates {
  reservationId: string;
  propertyId: string;
  status: string;
  source?: string;
  onSaved: (dates: StayDates) => void;
}
function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
function errorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('response' in error)) return undefined;
  const response = error.response;
  if (!response || typeof response !== 'object' || !('data' in response)) return undefined;
  const data = response.data;
  if (!data || typeof data !== 'object' || !('message' in data)) return undefined;
  return typeof data.message === 'string' ? data.message : undefined;
}

/** Dates-only staff operation. The PMS owns availability and accepted-tariff guards. */
export default function StayDateEditor(props: Props) {
  const { hasPermission } = useAuth();
  const { t } = useTranslation();
  const queries = useQueryClient();
  const id = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const arrivalInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [arrival, setArrival] = useState(props.arrivalDate);
  const [departure, setDeparture] = useState(props.departureDate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (editing) arrivalInput.current?.focus(); }, [editing]);
  if (!hasPermission('reservations.write') || !['pending', 'confirmed', 'assigned'].includes(props.status)
      || (props.source && props.source !== 'direct')) return null;
  const invalid = !validDate(arrival) || !validDate(departure) || departure <= arrival;
  const unchanged = arrival === props.arrivalDate && departure === props.departureDate;
  function close() { setEditing(false); requestAnimationFrame(() => editButton.current?.focus()); }
  return <section aria-label={t('reservations.stayDateEditor', { defaultValue: 'Stay dates' })} className="space-y-3 border-t border-gray-100 pt-4">
    {!editing ? <>
      <button ref={editButton} type="button" onClick={() => {
        setArrival(props.arrivalDate); setDeparture(props.departureDate); setError(''); setSaved(false); setEditing(true);
      }} className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-telivity-slate hover:bg-telivity-light-grey focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
        {t('reservations.editStayDates', { defaultValue: 'Edit stay dates' })}
      </button>
      {saved && <p role="status" className="text-sm text-telivity-slate">{t('reservations.stayDatesSaved', { defaultValue: 'Stay dates updated. Review the folio before taking or returning payment.' })}</p>}
    </> : <form aria-label={t('reservations.editStayDates', { defaultValue: 'Edit stay dates' })} aria-busy={saving}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!saving) close(); } }}
      onSubmit={async event => {
        event.preventDefault(); if (invalid || unchanged || saving) return;
        setSaving(true); setError('');
        try {
          await api.patch(`/v1/reservations/${props.reservationId}`, { arrivalDate: arrival, departureDate: departure },
            { params: { propertyId: props.propertyId }, skipErrorToast: true });
          props.onSaved({ arrivalDate: arrival, departureDate: departure });
          void queries.invalidateQueries({ queryKey: ['reservations'] });
          void queries.invalidateQueries({ queryKey: ['availability'] });
          void queries.invalidateQueries({ queryKey: ['calendar'] });
          setSaved(true); close();
        } catch (failure) {
          setError(errorMessage(failure) ?? t('reservations.stayDatesFailed', { defaultValue: 'Dates could not be saved. Check the connection and try again.' }));
        } finally { setSaving(false); }
      }} className="space-y-3">
      <p id={`${id}-help`} className="text-sm text-telivity-slate">{t('reservations.stayDatesHelp', { defaultValue: 'This changes dates only. The agreed total stays unchanged; review charges and payments separately. Reservations with accepted pricing require a Stay Amendment and cannot be changed here.' })}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div><label htmlFor={`${id}-arrival`} className="mb-1 block text-sm font-medium text-telivity-navy">{t('reservations.arrival')}</label>
          <input ref={arrivalInput} id={`${id}-arrival`} type="date" required value={arrival} disabled={saving} aria-describedby={`${id}-help ${id}-feedback`} aria-invalid={invalid}
            onChange={event => { setArrival(event.target.value); setError(''); }} className="w-full min-w-0 rounded-lg border border-gray-200 px-3 py-2 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" /></div>
        <div><label htmlFor={`${id}-departure`} className="mb-1 block text-sm font-medium text-telivity-navy">{t('reservations.departure')}</label>
          <input id={`${id}-departure`} type="date" required value={departure} disabled={saving} aria-describedby={`${id}-help ${id}-feedback`} aria-invalid={invalid}
            onChange={event => { setDeparture(event.target.value); setError(''); }} className="w-full min-w-0 rounded-lg border border-gray-200 px-3 py-2 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" /></div>
      </div>
      <p id={`${id}-feedback`} role={error ? 'alert' : 'status'} className="text-sm text-telivity-slate">{error || (invalid
        ? t('reservations.stayDatesInvalid', { defaultValue: 'Choose valid dates with departure after arrival.' })
        : unchanged ? t('reservations.stayDatesUnchanged', { defaultValue: 'Choose different dates to save a change.' }) : '')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={saving || invalid || unchanged} className="rounded-lg bg-telivity-teal px-4 py-2 text-sm font-semibold text-white hover:bg-telivity-light-teal disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          {saving ? t('common.saving', { defaultValue: 'Saving…' }) : t('reservations.saveStayDates', { defaultValue: 'Save dates' })}</button>
        <button type="button" disabled={saving} onClick={close} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-telivity-slate focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">{t('common.cancel')}</button>
      </div>
    </form>}
  </section>;
}

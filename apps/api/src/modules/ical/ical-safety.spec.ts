import { describe, it, expect } from 'vitest';
import { parseIcsBusyBlocks } from './ical.util';
const calendar = (extra = '') => `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:stable-uid\nDTSTART;VALUE=DATE:20261101\nDTEND;VALUE=DATE:20261104\n${extra}\nEND:VEVENT\nEND:VCALENDAR`;
describe('iCal import safety', () => {
  it('does not block cancelled or transparent events', () => {
    expect(parseIcsBusyBlocks(calendar('STATUS:CANCELLED'))).toEqual([]);
    expect(parseIcsBusyBlocks(calendar('TRANSP:TRANSPARENT'))).toEqual([]);
  });
  it('rejects error pages, invalid dates and unsupported recurrence before replacement', () => {
    expect(() => parseIcsBusyBlocks('<html>Provider error</html>')).toThrow();
    expect(() => parseIcsBusyBlocks(calendar().replace('20261101', '20260230'))).toThrow();
    expect(() => parseIcsBusyBlocks(calendar('RRULE:FREQ=DAILY'))).toThrow();
  });
  it('preserves the external UID through a repeated parse', () => {
    expect(parseIcsBusyBlocks(calendar())).toEqual(parseIcsBusyBlocks(calendar()));
    expect(parseIcsBusyBlocks(calendar())[0]?.externalUid).toBe('stable-uid');
  });
});

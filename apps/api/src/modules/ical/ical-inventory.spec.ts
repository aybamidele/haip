import { describe, expect, it } from 'vitest';
import { calendarExportSpans, importedCalendarOccupancy } from './ical-inventory';

const span = { startDate: '2027-01-01', endDate: '2027-01-04' };
const block = (feedId: string, roomId?: string) => ({ feedId, roomId, ...span });
const reservation = (id: string, roomId?: string) => ({ id, roomId, arrivalDate: span.startDate, departureDate: span.endDate });
const rooms = new Set(['unit-a', 'unit-b']);
describe('physical calendar inventory', () => {
  it('unites mirrored calendars for one unit while keeping distinct units and legacy feeds separate', () => {
    expect(importedCalendarOccupancy(span.startDate, [], [block('airbnb', 'unit-a'), block('booking', 'unit-a')], rooms)).toBe(1);
    expect(importedCalendarOccupancy(span.startDate, [], [block('a', 'unit-a'), block('b', 'unit-b')], rooms)).toBe(2);
    expect(importedCalendarOccupancy(span.startDate, [], [block('a'), block('b')], rooms)).toBe(2);
  });
  it('does not subtract a physically assigned unit or an out-of-service unit twice', () => {
    expect(importedCalendarOccupancy(span.startDate, [reservation('direct', 'unit-a')], [block('a', 'unit-a')], rooms)).toBe(0);
    expect(importedCalendarOccupancy(span.startDate, [], [block('a', 'inactive')], rooms)).toBe(0);
  });
  it('respects exclusive checkout and leaves cancelled/removed snapshots to callers', () => {
    expect(importedCalendarOccupancy(span.endDate, [], [block('a', 'unit-a')], rooms)).toBe(0);
    expect(calendarExportSpans([], [], rooms)).toEqual([]);
  });
  it('exports a pooled type only when capacity is exhausted, including imported inventory', () => {
    expect(calendarExportSpans([reservation('one')], [], rooms)).toEqual([]);
    expect(calendarExportSpans([reservation('one')], [block('a', 'unit-a')], rooms)).toEqual([span]);
    expect(calendarExportSpans([], [block('a', 'unit-a'), block('mirror', 'unit-a')], rooms)).toEqual([]);
  });
  it('keeps assigned reservations and mapped imports off another unit export', () => {
    expect(calendarExportSpans([reservation('one', 'unit-a')], [], rooms, 'unit-b')).toEqual([]);
    expect(calendarExportSpans([], [block('a', 'unit-a')], rooms, 'unit-a')).toEqual([span]);
    expect(calendarExportSpans([], [block('a', 'unit-a')], rooms, 'unit-b')).toEqual([]);
  });
  it('keeps unknown physical allocations conservative instead of guessing a room', () => {
    expect(calendarExportSpans([reservation('one')], [], rooms, 'unit-b')).toEqual([span]);
    expect(calendarExportSpans([], [block('unmapped')], rooms, 'unit-b')).toEqual([span]);
  });
  it('merges consecutive full intervals without losing overlap counts or creating empty nights', () => {
    const blocks = [block('a', 'unit-a'), { feedId: 'b', roomId: 'unit-b', startDate: '2027-01-02', endDate: '2027-01-03' },
      { feedId: 'c', roomId: 'unit-b', startDate: '2027-01-03', endDate: '2027-01-05' }];
    expect(calendarExportSpans([], blocks, rooms)).toEqual([{ startDate: '2027-01-02', endDate: '2027-01-04' }]);
  });
});

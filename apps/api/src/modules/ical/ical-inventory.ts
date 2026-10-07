export interface CalendarReservation {
  id: string;
  roomId?: string | null;
  arrivalDate: string;
  departureDate: string;
}
export interface CalendarInventoryBlock {
  feedId: string;
  roomId?: string | null;
  startDate: string;
  endDate: string;
}

/** Preserve reservation demand; mapped calendars consume each physical unit once. */
export function importedCalendarOccupancy(
  date: string,
  reservations: readonly CalendarReservation[],
  blocks: readonly CalendarInventoryBlock[],
  sellableRooms?: ReadonlySet<string>,
): number {
  const assigned = new Set(reservations.filter(r => r.arrivalDate <= date && r.departureDate > date).map(r => r.roomId).filter(Boolean));
  const identities = new Set<string>();
  for (const block of blocks) {
    if (block.startDate > date || block.endDate <= date) continue;
    if (block.roomId) {
      if (assigned.has(block.roomId) || sellableRooms && !sellableRooms.has(block.roomId)) continue;
      identities.add(`room:${block.roomId}`);
    } else identities.add(`feed:${block.feedId}`);
  }
  return identities.size;
}

/** Sweep interval boundaries, avoiding an unbounded day-by-day export scan. */
export function calendarExportSpans(
  reservations: readonly CalendarReservation[],
  blocks: readonly CalendarInventoryBlock[],
  sellableRooms: ReadonlySet<string>,
  roomId?: string | null,
): Array<{ startDate: string; endDate: string }> {
  type Change = { kind: 'reservation' | 'block'; key: string; delta: number; roomId?: string | null };
  const boundaries = new Map<string, Change[]>();
  const add = (date: string, change: Change) => {
    const changes = boundaries.get(date);
    if (changes) changes.push(change);
    else boundaries.set(date, [change]);
  };
  for (const row of reservations) {
    add(row.arrivalDate, { kind: 'reservation', key: row.id, delta: 1, roomId: row.roomId });
    add(row.departureDate, { kind: 'reservation', key: row.id, delta: -1, roomId: row.roomId });
  }
  for (const row of blocks) {
    add(row.startDate, { kind: 'block', key: row.roomId ? `room:${row.roomId}` : `feed:${row.feedId}`, delta: 1, roomId: row.roomId });
    add(row.endDate, { kind: 'block', key: row.roomId ? `room:${row.roomId}` : `feed:${row.feedId}`, delta: -1, roomId: row.roomId });
  }
  const dates = [...boundaries.keys()].sort();
  const assigned = new Map<string, number>();
  const imported = new Map<string, number>();
  let sold = 0, unassigned = 0, legacyImports = 0;
  const spans: Array<{ startDate: string; endDate: string }> = [];
  for (let index = 0; index < dates.length - 1; index++) {
    const date = dates[index]!;
    for (const change of boundaries.get(date)!) {
      if (change.kind === 'reservation') {
        sold += change.delta;
        if (change.roomId) assigned.set(change.roomId, (assigned.get(change.roomId) ?? 0) + change.delta);
        else unassigned += change.delta;
      } else {
        const before = imported.get(change.key) ?? 0;
        const after = before + change.delta;
        imported.set(change.key, after);
        if (!change.roomId) legacyImports += Number(after > 0) - Number(before > 0);
      }
    }
    let mappedImports = 0;
    for (const unit of sellableRooms) if ((imported.get(`room:${unit}`) ?? 0) > 0 && (assigned.get(unit) ?? 0) <= 0) mappedImports++;
    const full = sold + legacyImports + mappedImports >= sellableRooms.size;
    // Unassigned reservations/imports have no physical identity: conservatively keep
    // them in every unit export until staff maps/assigns them. Never guess allocation.
    const busy = roomId
      ? full || (assigned.get(roomId) ?? 0) > 0 || (imported.get(`room:${roomId}`) ?? 0) > 0 || unassigned > 0 || legacyImports > 0
      : full;
    if (!busy) continue;
    const previous = spans.at(-1);
    if (previous?.endDate === date) previous.endDate = dates[index + 1]!;
    else spans.push({ startDate: date, endDate: dates[index + 1]! });
  }
  return spans;
}

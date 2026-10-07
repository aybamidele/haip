import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, gt, lt, ne, notInArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { icalBlocks, icalFeeds, reservations, rooms, roomTypes } from '@telivityhaip/database';

type ReservationRow = typeof reservations.$inferSelect;

/** Same room-type mutex used by canonical create, availability edits and iCal replacement. */
export async function lockRoomInventory(db: PostgresJsDatabase, propertyId: string, roomTypeId: string) {
  const [type] = await db.select({ id: roomTypes.id, isActive: roomTypes.isActive, maxOccupancy: roomTypes.maxOccupancy })
    .from(roomTypes).where(and(eq(roomTypes.id, roomTypeId), eq(roomTypes.propertyId, propertyId))).for('update');
  if (!type) throw new NotFoundException(`room type ${roomTypeId} not found in this property`);
  return type;
}

/** Reservation first, then ordered inventory locks: matches accepted-stay amendments. */
export async function lockAllocationSnapshot(db: PostgresJsDatabase, snapshot: ReservationRow, nextRoomTypeId?: string) {
  const [current] = await db.select().from(reservations)
    .where(and(eq(reservations.id, snapshot.id), eq(reservations.propertyId, snapshot.propertyId))).for('update');
  if (!current) throw new NotFoundException(`Reservation ${snapshot.id} not found`);
  if (current.updatedAt.getTime() !== snapshot.updatedAt.getTime()
    || current.status !== snapshot.status || current.roomId !== snapshot.roomId
    || current.roomTypeId !== snapshot.roomTypeId || current.arrivalDate !== snapshot.arrivalDate
    || current.departureDate !== snapshot.departureDate || current.doNotMove !== snapshot.doNotMove) {
    throw new ConflictException('Reservation changed; refresh it before assigning a room or changing its stay');
  }
  for (const typeId of [...new Set([current.roomTypeId, nextRoomTypeId ?? current.roomTypeId])].sort()) {
    await lockRoomInventory(db, current.propertyId, typeId);
  }
  return current;
}

/** Caller must hold the room-type inventory mutex through its write. Checkout is exclusive. */
export async function assertRoomStayAvailable(db: PostgresJsDatabase, input: {
  propertyId: string; roomTypeId: string; roomId: string;
  arrivalDate: string; departureDate: string; excludeReservationId?: string;
}) {
  const { propertyId, roomTypeId, roomId, arrivalDate, departureDate } = input;
  const [room] = await db.select({ id: rooms.id }).from(rooms).where(and(
    eq(rooms.id, roomId), eq(rooms.propertyId, propertyId), eq(rooms.roomTypeId, roomTypeId), eq(rooms.isActive, true),
  ));
  if (!room) throw new BadRequestException('Selected room is not active in this property and room type');
  const [overlap] = await db.select({ id: reservations.id }).from(reservations).where(and(
    eq(reservations.propertyId, propertyId), eq(reservations.roomId, roomId),
    notInArray(reservations.status, ['cancelled', 'no_show', 'checked_out']),
    lt(reservations.arrivalDate, departureDate), gt(reservations.departureDate, arrivalDate),
    ...(input.excludeReservationId ? [ne(reservations.id, input.excludeReservationId)] : []),
  )).limit(1);
  if (overlap) throw new ConflictException('Selected room has an overlapping reservation for these dates');
  // Unmapped imports have no physical identity; canonical room-type availability
  // retains their demand. Only explicitly mapped, active import feeds identify this unit.
  const [blocked] = await db.select({ id: icalBlocks.id }).from(icalBlocks).innerJoin(icalFeeds, and(
    eq(icalFeeds.id, icalBlocks.feedId), eq(icalFeeds.propertyId, propertyId),
    eq(icalFeeds.roomTypeId, roomTypeId), eq(icalFeeds.roomId, roomId),
    eq(icalFeeds.isActive, true), eq(icalFeeds.direction, 'import'),
  )).where(and(eq(icalBlocks.propertyId, propertyId), eq(icalBlocks.roomTypeId, roomTypeId),
    lt(icalBlocks.startDate, departureDate), gt(icalBlocks.endDate, arrivalDate))).limit(1);
  if (blocked) throw new ConflictException('Selected room is blocked by an imported calendar for these dates');
}

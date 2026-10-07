import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gt, lt, inArray, notInArray, sql } from 'drizzle-orm';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  auditLogs,
  icalBlocks,
  icalFeeds,
  reservations,
  roomTypes,
  rooms,
} from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { UnsafeUrlError } from '../../common/security/url-guard';
import { CalendarFetchError, fetchPublicCalendar } from './ical-fetch';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@telivityhaip/database';
import { calendarExportSpans } from './ical-inventory';
import {
  CreateIcalFeedDto,
  ListIcalBlocksDto,
  ListIcalFeedsDto,
  UpdateIcalFeedDto,
} from './dto/ical.dto';
import {
  buildIcsCalendar,
  mergeBusyBlocks,
  parseIcsBusyBlocks,
  type IcalBusyBlock,
} from './ical.util';

type IcalFeedRow = typeof icalFeeds.$inferSelect;

interface ExportTokenPayload {
  kind: 'ical-export';
  feedId: string;
  propertyId: string;
  roomTypeId: string;
  roomId?: string | null;
  nonce: string;
}

@Injectable()
export class IcalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly config: ConfigService,
  ) {}

  async create(dto: CreateIcalFeedDto) {
    await this.assertRoomTypeAtProperty(dto.roomTypeId, dto.propertyId);
    if (dto.roomId) await this.assertRoomAtType(dto.roomId, dto.roomTypeId, dto.propertyId);
    if (dto.direction === 'import' && !dto.sourceUrl) {
      throw new BadRequestException('sourceUrl is required for import feeds');
    }
    if (dto.direction === 'export' && dto.sourceUrl) {
      throw new BadRequestException('sourceUrl is only valid for import feeds');
    }

    const result = await this.db.transaction(async (tx) => {
      const [feed] = await tx
        .insert(icalFeeds)
        .values({
          propertyId: dto.propertyId,
          roomTypeId: dto.roomTypeId,
          roomId: dto.roomId ?? null,
          direction: dto.direction,
          name: dto.name,
          sourceUrl: dto.direction === 'import' ? dto.sourceUrl : null,
        })
        .returning();

      if (!feed) throw new Error('Calendar feed creation failed');
      let exportUrl: string | undefined;
      if (dto.direction === 'export') {
        const token = this.signExportToken(feed);
        exportUrl = this.exportUrlForToken(token);
        const [updated] = await tx
          .update(icalFeeds)
          .set({ tokenHash: hashToken(token), updatedAt: new Date() })
          .where(and(eq(icalFeeds.id, feed.id), eq(icalFeeds.propertyId, dto.propertyId)))
          .returning();
        Object.assign(feed, updated);
      }

      await tx.insert(auditLogs).values({
        propertyId: dto.propertyId,
        action: 'create',
        entityType: 'ical_feed',
        entityId: feed.id,
        newValue: this.auditFeedValue(feed),
        description: `ical_feed.created:${dto.direction}`,
      });

      return { feed: this.publicFeed(feed), exportUrl };
    });

    return result;
  }

  async list(dto: ListIcalFeedsDto) {
    const conditions = [eq(icalFeeds.propertyId, dto.propertyId)];
    if (dto.roomTypeId) conditions.push(eq(icalFeeds.roomTypeId, dto.roomTypeId));
    if (dto.direction) conditions.push(eq(icalFeeds.direction, dto.direction));

    const rows = await this.db
      .select()
      .from(icalFeeds)
      .where(and(...conditions))
      .orderBy(desc(icalFeeds.createdAt));

    return rows.map((row: IcalFeedRow) => this.publicFeed(row));
  }

  async findById(id: string, propertyId: string) {
    return this.publicFeed(await this.findByIdRaw(id, propertyId));
  }

  async update(id: string, propertyId: string, dto: UpdateIcalFeedDto) {
    const existing = await this.findByIdRaw(id, propertyId);
    if (dto.roomId !== undefined && existing.direction === 'export' && dto.roomId !== (existing.roomId ?? null)) {
      throw new BadRequestException('Export unit mapping is fixed; create a new export calendar for another unit');
    }
    if (dto.roomId) await this.assertRoomAtType(dto.roomId, existing.roomTypeId, propertyId);
    if (existing.direction === 'export' && dto.sourceUrl) {
      throw new BadRequestException('sourceUrl is only valid for import feeds');
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.roomId !== undefined) patch['roomId'] = dto.roomId;
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.isActive !== undefined) patch['isActive'] = dto.isActive;
    if (dto.sourceUrl !== undefined) {
      patch['sourceUrl'] = dto.sourceUrl;
      if (dto.sourceUrl !== existing.sourceUrl) {
        // Changed sources are due immediately; retain last-good blocks until validation succeeds.
        patch['lastSyncAt'] = null;
        patch['lastSyncStatus'] = null;
        patch['lastSyncError'] = null;
        patch['consecutiveSyncFailures'] = 0;
      }
    }

    const updated = await this.db.transaction(async tx => {
      const [locked] = await tx.select().from(icalFeeds)
        .where(and(eq(icalFeeds.id, id), eq(icalFeeds.propertyId, propertyId))).for('update');
      if (!locked) throw new NotFoundException(`iCal feed ${id} not found`);
      if (dto.roomId !== undefined) {
        await tx.select({ id: roomTypes.id }).from(roomTypes)
          .where(and(eq(roomTypes.id, locked.roomTypeId), eq(roomTypes.propertyId, propertyId))).for('update');
      }
      const [row] = await tx.update(icalFeeds).set(patch)
        .where(and(eq(icalFeeds.id, id), eq(icalFeeds.propertyId, propertyId))).returning();
      return row;
    });
    if (!updated) throw new NotFoundException(`iCal feed ${id} not found`);

    await this.db.insert(auditLogs).values({
      propertyId,
      action: 'update',
      entityType: 'ical_feed',
      entityId: id,
      previousValue: this.auditFeedValue(existing),
      newValue: this.auditFeedValue(updated),
      description: 'ical_feed.updated',
    });

    return this.publicFeed(updated);
  }

  async delete(id: string, propertyId: string) {
    const existing = await this.findByIdRaw(id, propertyId);

    await this.db.transaction(async (tx) => {
      // Follow the import lock order so deletion cannot race a snapshot replacement.
      await tx.select({ id: icalFeeds.id }).from(icalFeeds)
        .where(and(eq(icalFeeds.id, id), eq(icalFeeds.propertyId, propertyId))).for('update');
      await tx
        .delete(icalBlocks)
        .where(and(eq(icalBlocks.feedId, id), eq(icalBlocks.propertyId, propertyId)));
      await tx
        .delete(icalFeeds)
        .where(and(eq(icalFeeds.id, id), eq(icalFeeds.propertyId, propertyId)));
      await tx.insert(auditLogs).values({
        propertyId,
        action: 'delete',
        entityType: 'ical_feed',
        entityId: id,
        previousValue: this.auditFeedValue(existing),
        description: 'ical_feed.deleted',
      });
    });

    return { deleted: true };
  }

  async rotateExportToken(id: string, propertyId: string) {
    const feed = await this.findByIdRaw(id, propertyId);
    if (feed.direction !== 'export') {
      throw new BadRequestException('Only export feeds have tokens');
    }

    const token = this.signExportToken(feed);
    const [updated] = await this.db
      .update(icalFeeds)
      .set({ tokenHash: hashToken(token), updatedAt: new Date() })
      .where(and(eq(icalFeeds.id, id), eq(icalFeeds.propertyId, propertyId)))
      .returning();
    if (!updated) throw new NotFoundException(`iCal feed ${id} not found`);

    await this.db.insert(auditLogs).values({
      propertyId,
      action: 'update',
      entityType: 'ical_feed',
      entityId: id,
      description: 'ical_feed.token_rotated',
    });

    return { feed: this.publicFeed(updated), exportUrl: this.exportUrlForToken(token) };
  }

  async syncImportFeed(id: string, propertyId: string, dueBefore?: Date) {
    // Check scope before SKIP LOCKED so a busy row is not confused with an absent tenant row.
    await this.findByIdRaw(id, propertyId);
    const result = await this.db.transaction(async (tx) => {
      const [feed] = await tx.select().from(icalFeeds)
        .where(and(eq(icalFeeds.id, id), eq(icalFeeds.propertyId, propertyId)))
        .for('update', { skipLocked: true });
      if (!feed) return { skipped: true as const };
      if (dueBefore && feed.lastSyncAt && feed.lastSyncAt > dueBefore) return { skipped: true as const };
      if (feed.direction !== 'import' || !feed.isActive || !feed.sourceUrl) {
        if (dueBefore) return { skipped: true as const };
        throw new BadRequestException('Only active import feeds with a source URL can be synced');
      }

      let parsed: IcalBusyBlock[];
      try {
        const ics = await this.fetchIcs(feed.sourceUrl);
        if ((ics.match(/BEGIN:VEVENT/gi) ?? []).length > 10_000) throw new CalendarFetchError('Calendar contains too many events');
        const events = parseIcsBusyBlocks(ics);
        const legacyIds = events.map(block => /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@haip$/i.exec(block.externalUid)?.[1])
          .filter((id): id is string => Boolean(id));
        const known = legacyIds.length ? await tx.select({ id: reservations.id }).from(reservations)
          .where(and(eq(reservations.propertyId, propertyId), eq(reservations.roomTypeId, feed.roomTypeId), inArray(reservations.id, legacyIds))) : [];
        const legacyUids = new Set(known.map(row => `${row.id}@haip`));
        // Filter exact authenticated HAIP echoes before merging destroys UID identity.
        parsed = mergeBusyBlocks(events.filter(block => !legacyUids.has(block.externalUid) && !this.isExportEcho(feed, block)));
      } catch (err) {
        // Parser/network errors can contain a private feed URL or guest summary.
        const error = err instanceof UnsafeUrlError || err instanceof CalendarFetchError
          ? err.message : 'Invalid or unsupported calendar';
        await tx.update(icalFeeds).set({
          lastSyncAt: new Date(), lastSyncStatus: 'failed', lastSyncError: error,
          consecutiveSyncFailures: sql`${icalFeeds.consecutiveSyncFailures} + 1`, updatedAt: new Date(),
        }).where(and(eq(icalFeeds.id, id), eq(icalFeeds.propertyId, propertyId)));
        // Commit only failure metadata; the previous busy snapshot remains intact.
        return { error };
      }

      // Share canonical reservation creation's inventory mutex for replacement.
      await tx.select({ id: roomTypes.id }).from(roomTypes)
        .where(and(eq(roomTypes.id, feed.roomTypeId), eq(roomTypes.propertyId, propertyId)))
        .for('update');
      const values = parsed.map((block) => this.blockInsertValue(feed, block));
      await tx.delete(icalBlocks).where(and(eq(icalBlocks.feedId, id), eq(icalBlocks.propertyId, propertyId)));
      if (values.length > 0) await tx.insert(icalBlocks).values(values);
      const now = new Date();
      const [updated] = await tx.update(icalFeeds).set({
        lastSyncAt: now, lastSuccessfulSyncAt: now, consecutiveSyncFailures: 0,
        lastSyncStatus: 'success', lastSyncError: null, updatedAt: now,
      }).where(and(eq(icalFeeds.id, id), eq(icalFeeds.propertyId, propertyId))).returning();
      await tx.insert(auditLogs).values({
        propertyId, action: 'update', entityType: 'ical_feed', entityId: id,
        newValue: { blocksImported: values.length }, description: 'ical_feed.synced',
      });
      return { feed: this.publicFeed(updated!), blocksImported: values.length };
    });
    if ('error' in result) throw new BadRequestException(`iCal import failed: ${result.error}`);
    if ('skipped' in result) {
      if (dueBefore) return { skipped: true as const };
      throw new ConflictException('Calendar sync is already running; refresh its status shortly');
    }
    return result;
  }

  async listBlocks(feedId: string, dto: ListIcalBlocksDto) {
    await this.findByIdRaw(feedId, dto.propertyId);
    const conditions = [
      eq(icalBlocks.feedId, feedId),
      eq(icalBlocks.propertyId, dto.propertyId),
    ];
    if (dto.startDate) conditions.push(gt(icalBlocks.endDate, dto.startDate));
    if (dto.endDate) conditions.push(lt(icalBlocks.startDate, dto.endDate));

    return this.db
      .select()
      .from(icalBlocks)
      .where(and(...conditions))
      .orderBy(icalBlocks.startDate);
  }

  async listOverlappingBlocks(
    propertyId: string,
    roomTypeId: string,
    startDate: string,
    endDate: string,
    db?: any,
  ) {
    const conn = db ?? this.db;
    return conn
      .select({
        id: icalBlocks.id,
        feedId: icalBlocks.feedId,
        roomId: icalFeeds.roomId,
        roomTypeId: icalBlocks.roomTypeId,
        startDate: icalBlocks.startDate,
        endDate: icalBlocks.endDate,
        summary: icalBlocks.summary,
      })
      .from(icalBlocks)
      .innerJoin(
        icalFeeds,
        and(
          eq(icalFeeds.id, icalBlocks.feedId),
          eq(icalFeeds.propertyId, propertyId),
          eq(icalFeeds.isActive, true),
          eq(icalFeeds.direction, 'import'),
        ),
      )
      .where(
        and(
          eq(icalBlocks.propertyId, propertyId),
          eq(icalBlocks.roomTypeId, roomTypeId),
          lt(icalBlocks.startDate, endDate),
          gt(icalBlocks.endDate, startDate),
        ),
      );
  }

  async exportCalendar(token: string) {
    const feed = await this.verifyExportToken(token);
    const excludedStatuses = ['cancelled', 'no_show', 'checked_out'] as const;
    const rows = await this.db
      .select({
        id: reservations.id,
        roomId: reservations.roomId,
        arrivalDate: reservations.arrivalDate,
        departureDate: reservations.departureDate,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.propertyId, feed.propertyId),
          eq(reservations.roomTypeId, feed.roomTypeId),
          notInArray(reservations.status, excludedStatuses as any),
        ),
      )
      .orderBy(reservations.arrivalDate);

    const units = await this.db.select({ id: rooms.id }).from(rooms)
      .where(and(eq(rooms.propertyId, feed.propertyId), eq(rooms.roomTypeId, feed.roomTypeId), eq(rooms.isActive, true),
        notInArray(rooms.status, ['out_of_order', 'out_of_service'])));
    if (!units.length) throw new BadRequestException('Room type has no sellable units');
    if (feed.roomId && !units.some(unit => unit.id === feed.roomId)) throw new BadRequestException('Calendar unit is not currently sellable');
    const blocks = await this.db.select({ feedId: icalBlocks.feedId, roomId: icalFeeds.roomId,
      startDate: icalBlocks.startDate, endDate: icalBlocks.endDate }).from(icalBlocks)
      .innerJoin(icalFeeds, and(eq(icalFeeds.id, icalBlocks.feedId), eq(icalFeeds.propertyId, feed.propertyId),
        eq(icalFeeds.isActive, true), eq(icalFeeds.direction, 'import')))
      .where(and(eq(icalBlocks.propertyId, feed.propertyId), eq(icalBlocks.roomTypeId, feed.roomTypeId)));
    if (rows.length + blocks.length > 10_000) throw new BadRequestException('Calendar export exceeds the supported event limit');
    return buildIcsCalendar(calendarExportSpans(rows, blocks, new Set(units.map(unit => unit.id)), feed.roomId).map(span => ({
      uid: this.exportEventUid(feed, span),
      ...span,
      summary: 'Busy',
    })));
  }

  private async findByIdRaw(id: string, propertyId: string): Promise<IcalFeedRow> {
    const [feed] = await this.db
      .select()
      .from(icalFeeds)
      .where(and(eq(icalFeeds.id, id), eq(icalFeeds.propertyId, propertyId)));
    if (!feed) throw new NotFoundException(`iCal feed ${id} not found`);
    return feed;
  }

  private async assertRoomTypeAtProperty(roomTypeId: string, propertyId: string) {
    const [roomType] = await this.db
      .select({ id: roomTypes.id })
      .from(roomTypes)
      .where(and(eq(roomTypes.id, roomTypeId), eq(roomTypes.propertyId, propertyId)));
    if (!roomType) {
      throw new BadRequestException(`room type ${roomTypeId} not found in this property`);
    }
  }

  private async assertRoomAtType(roomId: string, roomTypeId: string, propertyId: string) {
    const [room] = await this.db.select({ id: rooms.id }).from(rooms)
      .where(and(eq(rooms.id, roomId), eq(rooms.roomTypeId, roomTypeId), eq(rooms.propertyId, propertyId), eq(rooms.isActive, true)));
    if (!room) throw new BadRequestException('Calendar unit must belong to the selected property and room type');
  }

  private exportEventUid(feed: Pick<IcalFeedRow, 'propertyId' | 'roomTypeId' | 'roomId'>, span: { startDate: string; endDate: string }): string {
    const identity = [feed.propertyId, feed.roomTypeId, feed.roomId ?? 'pool', span.startDate, span.endDate].join('|');
    return `haip-calendar-v1-${createHmac('sha256', this.signingSecret()).update(identity).digest('hex')}@haip`;
  }

  private isExportEcho(feed: IcalFeedRow, block: IcalBusyBlock): boolean {
    if (!block.externalUid.startsWith('haip-calendar-v1-')) return false;
    return safeEqual(block.externalUid, this.exportEventUid(feed, block))
      || Boolean(feed.roomId && safeEqual(block.externalUid, this.exportEventUid({ ...feed, roomId: null }, block)));
  }

  private async verifyExportToken(token: string): Promise<IcalFeedRow> {
    const payload = this.parseAndVerifyToken(token);
    const [feed] = await this.db
      .select()
      .from(icalFeeds)
      .where(
        and(
          eq(icalFeeds.id, payload.feedId),
          eq(icalFeeds.propertyId, payload.propertyId),
          eq(icalFeeds.roomTypeId, payload.roomTypeId),
          eq(icalFeeds.direction, 'export'),
          eq(icalFeeds.isActive, true),
        ),
      );
    if (!feed || (feed.roomId ?? null) !== (payload.roomId ?? null) || !feed.tokenHash || feed.tokenHash !== hashToken(token)) {
      throw new UnauthorizedException('Invalid iCal feed token');
    }
    return feed;
  }

  private signExportToken(feed: Pick<IcalFeedRow, 'id' | 'propertyId' | 'roomTypeId' | 'roomId'>): string {
    const payload: ExportTokenPayload = {
      kind: 'ical-export',
      feedId: feed.id,
      propertyId: feed.propertyId,
      roomTypeId: feed.roomTypeId,
      roomId: feed.roomId ?? null,
      nonce: randomBytes(16).toString('hex'),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.signingSecret()).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private parseAndVerifyToken(token: string): ExportTokenPayload {
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) {
      throw new UnauthorizedException('Invalid iCal feed token');
    }
    const expected = createHmac('sha256', this.signingSecret()).update(encoded).digest('base64url');
    if (!safeEqual(signature, expected)) {
      throw new UnauthorizedException('Invalid iCal feed token');
    }

    let parsed: Partial<ExportTokenPayload>;
    try {
      parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<ExportTokenPayload>;
    } catch {
      throw new UnauthorizedException('Invalid iCal feed token');
    }
    if (
      parsed.kind !== 'ical-export' ||
      !parsed.feedId ||
      !parsed.propertyId ||
      !parsed.roomTypeId ||
      !parsed.nonce
    ) {
      throw new UnauthorizedException('Invalid iCal feed token');
    }
    return parsed as ExportTokenPayload;
  }

  private exportUrlForToken(token: string): string {
    const base = (
      this.config.get<string>('PUBLIC_API_BASE_URL') ??
      this.config.get<string>('API_BASE_URL') ??
      ''
    ).replace(/\/$/, '');
    return `${base}/ical/export.ics?token=${encodeURIComponent(token)}`;
  }

  private signingSecret(): string {
    return (
      this.config.get<string>('ICAL_SIGNING_SECRET') ??
      this.config.get<string>('JWT_SECRET') ??
      'dev-ical-signing-secret-change-me'
    );
  }

  private fetchIcs(url: string): Promise<string> {
    return fetchPublicCalendar(url);
  }

  private blockInsertValue(feed: IcalFeedRow, block: IcalBusyBlock) {
    const source = `${block.externalUid}|${block.startDate}|${block.endDate}|${block.summary ?? ''}`;
    return {
      propertyId: feed.propertyId,
      feedId: feed.id,
      roomTypeId: feed.roomTypeId,
      externalUid: block.externalUid,
      startDate: block.startDate,
      endDate: block.endDate,
      summary: block.summary ?? null,
      sourceChecksum: createHash('sha256').update(source).digest('hex'),
    };
  }

  private publicFeed(feed: IcalFeedRow) {
    const safe = { ...feed };
    delete (safe as { tokenHash?: string | null }).tokenHash;
    return safe;
  }

  private auditFeedValue(feed: IcalFeedRow) {
    return {
      id: feed.id,
      propertyId: feed.propertyId,
      roomTypeId: feed.roomTypeId,
      roomId: feed.roomId,
      direction: feed.direction,
      name: feed.name,
      hasSourceUrl: Boolean(feed.sourceUrl),
      isActive: feed.isActive,
      lastSyncAt: feed.lastSyncAt,
      lastSyncStatus: feed.lastSyncStatus,
    };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

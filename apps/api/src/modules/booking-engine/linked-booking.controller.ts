import { Body, Controller, ForbiddenException, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { userCanAccessProperty } from '../auth/property-access';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsService } from '../auth/permissions.service';
import { BookingEngineService } from './booking-engine.service';
import { BookingThrottleGuard } from './booking-throttle.guard';
import { BeLinkedBookingDto } from './dto/be-linked-booking.dto';

/**
 * Trusted integrations can reuse a guest without exposing IDs through the public widget.
 * Global JWT, property and permission guards protect the target; source access is checked too.
 */
@ApiTags('Booking Engine — Trusted Integrations')
@ApiBearerAuth()
@Controller('booking-engine')
export class LinkedBookingController {
  constructor(
    private readonly service: BookingEngineService,
    private readonly permissions: PermissionsService,
  ) {}

  @Post('linked-bookings')
  @RequirePermissions('reservations.write', 'guests.write')
  @UseGuards(BookingThrottleGuard)
  @ApiOperation({ summary: 'Book through the canonical engine using an existing scoped guest' })
  async book(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: BeLinkedBookingDto,
    @CurrentUser() user: AuthUser,
  ) {
    // No auth-off bypass: reusing existing PII always requires an identified principal.
    if (!user || !userCanAccessProperty(user, dto.sourcePropertyId)) {
      throw new ForbiddenException('Guest source property access is required');
    }
    const local = await this.permissions.findLocalUser(user.sub, user.email);
    const granted = local
      ? await this.permissions.getEffectivePermissions(local.id, dto.sourcePropertyId)
      : [];
    if (!granted.includes('guests.write')) {
      throw new ForbiddenException('Guest source property permission is required');
    }
    return this.service.book(propertyId, dto, { guestId: dto.guestId, propertyId: dto.sourcePropertyId });
  }
}

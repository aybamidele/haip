import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { BeCreateBookingDto } from './be-create-booking.dto';

/** Existing guest references are accepted only by the JWT-protected integration route. */
export class BeLinkedBookingDto extends BeCreateBookingDto {
  @ApiProperty()
  @IsUUID()
  guestId!: string;

  @ApiProperty({ description: 'Property where this guest already has a reservation; caller must have access.' })
  @IsUUID()
  sourcePropertyId!: string;
}

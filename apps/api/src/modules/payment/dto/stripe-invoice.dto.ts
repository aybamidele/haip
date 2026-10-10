import { IsInt, IsUUID, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
export class CreateStripeInvoiceDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsUUID() folioId!: string;
  @ApiProperty() @IsUUID() documentId!: string;
  @ApiProperty({ minimum: 1, maximum: 365 }) @IsInt() @Min(1) @Max(365) dueDays!: number;
}

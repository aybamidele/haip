import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsMoneyString } from '../../../common/validation/is-money-string.validator';

export class RefundPaymentDto {
  @ApiPropertyOptional({ description: 'Refund amount in major units; omitted means remaining captured balance' })
  @IsOptional() @IsMoneyString() amount?: string;
  @ApiPropertyOptional({ description: 'Stable identity for this refund intent; required for explicit-amount Stripe refunds' })
  @IsOptional() @IsString() @MaxLength(128) @Matches(/^[A-Za-z0-9_:.-]+$/) idempotencyKey?: string;
}

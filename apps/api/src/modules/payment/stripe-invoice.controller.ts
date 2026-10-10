import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CreateStripeInvoiceDto } from './dto/stripe-invoice.dto';
import { StripeInvoiceService } from './stripe-invoice.service';

@ApiTags('Stripe invoices')
@Controller('stripe-invoices')
export class StripeInvoiceController {
  constructor(private readonly invoices: StripeInvoiceService) {}
  @Post() @RequirePermissions('folios.manage')
  @ApiOperation({ summary: 'Create a draft Stripe invoice from a requested fiscal document and current folio balance' })
  create(@Body() dto: CreateStripeInvoiceDto) { return this.invoices.create(dto); }
  @Get() @RequirePermissions('folios.read')
  @ApiOperation({ summary: 'List Stripe invoice references for a property-scoped folio' })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiQuery({ name: 'folioId', required: true })
  list(@Query('folioId', ParseUUIDPipe) folioId: string, @Query('propertyId', ParseUUIDPipe) propertyId: string) {
    return this.invoices.list(folioId, propertyId);
  }
  @Get(':id') @RequirePermissions('folios.read')
  @ApiOperation({ summary: 'Read the property-scoped Stripe invoice reference' })
  @ApiQuery({ name: 'propertyId', required: true })
  read(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string) { return this.invoices.read(id, propertyId); }
  @Post(':id/send') @RequirePermissions('folios.manage')
  @ApiOperation({ summary: 'Revalidate balance, finalize and send the draft hosted invoice' })
  @ApiQuery({ name: 'propertyId', required: true })
  send(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string) { return this.invoices.send(id, propertyId); }
  @Post(':id/void') @RequirePermissions('folios.manage')
  @ApiOperation({ summary: 'Void a collectible Stripe invoice before recording alternative payment' })
  @ApiQuery({ name: 'propertyId', required: true })
  void(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string) { return this.invoices.void(id, propertyId); }
}

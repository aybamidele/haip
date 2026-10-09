import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LinkedBookingController } from './linked-booking.controller';
import { BookingEngineService } from './booking-engine.service';
import { PermissionsService } from '../auth/permissions.service';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { PERMISSIONS_KEY } from '../auth/permissions.decorator';
import { BeCreateBookingDto } from './dto/be-create-booking.dto';
const source = 'a0000001-0000-4000-a000-000000000001';
const target = 'a0000001-0000-4000-a000-000000000002';
const guestId = 'b0000001-0000-4000-a000-000000000001';
const dto = { roomTypeId:source,ratePlanId:target,checkIn:'2027-08-10',checkOut:'2027-08-12',guestFirstName:'Ada',guestLastName:'Guest',guestEmail:'ada@example.test',adults:1,guestId,sourcePropertyId:source };
function setup(grants=['guests.write']) {
  const service={ book:vi.fn().mockResolvedValue({success:true}) };
  const permissions={findLocalUser:vi.fn().mockResolvedValue({id:'principal'}),getEffectivePermissions:vi.fn().mockResolvedValue(grants)};
  return { service, permissions, controller:new LinkedBookingController(service as unknown as BookingEngineService,permissions as unknown as PermissionsService) };
}
describe('trusted existing guest booking boundary',()=>{
  it('is not public and requires both write permissions on the target property',()=>{
    expect(Reflect.getMetadata(IS_PUBLIC_KEY,LinkedBookingController)).toBeUndefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY,LinkedBookingController.prototype.book)).toBeUndefined();
    expect(Reflect.getMetadata(PERMISSIONS_KEY,LinkedBookingController.prototype.book)).toEqual(['reservations.write','guests.write']);
  });
  it('checks the source membership and permission before delegating to the canonical engine',async()=>{
    const f=setup();
    await f.controller.book(target,dto,{sub:'service',email:'service@example.test',name:'Integration',roles:[],propertyIds:[source,target]});
    expect(f.permissions.getEffectivePermissions).toHaveBeenCalledWith('principal',source);
    expect(f.service.book).toHaveBeenCalledWith(target,dto,{guestId,propertyId:source});
  });
  it('rejects a principal with target access but no source access',async()=>{
    const f=setup();
    await expect(f.controller.book(target,dto,{sub:'service',email:'service@example.test',name:'Integration',roles:[],propertyIds:[target]})).rejects.toThrow();
    expect(f.service.book).not.toHaveBeenCalled();
  });
  it('rejects read-only source permission and missing local principals',async()=>{
    const f=setup(['reservations.read']);const user={sub:'service',email:'service@example.test',name:'Integration',roles:[],propertyIds:[source,target]};
    await expect(f.controller.book(target,dto,user)).rejects.toThrow();
    f.permissions.findLocalUser.mockResolvedValue(undefined);
    await expect(f.controller.book(target,dto,user)).rejects.toThrow();
    expect(f.service.book).not.toHaveBeenCalled();
  });
  it('rejects guest references through the low-trust public booking DTO',async()=>{
    const errors=await validate(plainToInstance(BeCreateBookingDto,dto),{whitelist:true,forbidNonWhitelisted:true});
    expect(errors.map(error=>error.property)).toEqual(expect.arrayContaining(['guestId','sourcePropertyId']));
  });
});

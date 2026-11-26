import { VEHICLE_GROUPS } from './catalogue.js';
import { vehicleChoices } from '../supabase/functions/_shared/vehicle-models';

export { actVehicleName, findVehicleChoice, requiresOkavangoYear } from '../supabase/functions/_shared/vehicle-models';
export const orderVehicleChoices = vehicleChoices(VEHICLE_GROUPS);

export function vehicleGroupLabel(group: (typeof VEHICLE_GROUPS)[number]) {
  const brands = new Set(orderVehicleChoices.filter(choice => choice.group === group.code).map(choice => choice.brand));
  return brands.size ? [...brands].join(' / ') + ' · ' + group.name : group.name;
}

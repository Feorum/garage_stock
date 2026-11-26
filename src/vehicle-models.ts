import { VEHICLE_GROUPS } from './catalogue.js';
import { vehicleChoices } from '../supabase/functions/_shared/vehicle-models';

export { actVehicleName, findVehicleChoice, requiresOkavangoYear } from '../supabase/functions/_shared/vehicle-models';
export const orderVehicleChoices = vehicleChoices(VEHICLE_GROUPS);

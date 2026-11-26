import registry from './vehicle-models.json' with { type: 'json' };

// Operational labels only. The price matrix stays keyed by its existing group codes.
export interface VehicleChoice {
  brand: string;
  model: string;
  group: string;
  label: string;
  aliases: string[];
}

function choice(brand: string, model: string, group: string, aliases: string[] = []): VehicleChoice {
  return { brand, model, group, label: brand + ' ' + model, aliases };
}

const models = registry.map(({ brand, model, group, aliases }) => choice(brand, model, group, aliases));

function key(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/х/g, 'x').replace(/ё/g, 'е')
    .replace(/[()\s–—_-]/g, '');
}

// The workbook can add a separate year/range. Never use a neighbouring year's price.
export function vehicleChoices(groups: { code: string; name: string }[]): VehicleChoice[] {
  const active = new Set(groups.map(group => group.code));
  const result = models.filter(model => active.has(model.group));
  for (const group of groups) {
    const match = /^(?:ok[ao]vango|окаванго)\s+(\d{2}|\d{4})(?:\s*[-–—]\s*(\d{2}|\d{4}))?$/iu.exec(group.name.trim());
    if (!match) continue;
    const year = (token: string) => token.length === 2 ? 2000 + Number(token) : Number(token);
    const start = year(match[1]), end = year(match[2] || match[1]);
    if (start < 1900 || end < start || end - start > 100) continue;
    for (let value = start; value <= end; value++)
      result.push(choice('GEELY', 'OKAVANGO ' + value, group.code, ['Okovango ' + value, 'Окаванго ' + value]));
  }
  // Overlapping rows require the price catalogue to be clarified.
  const count = new Map<string, number>();
  for (const item of result) count.set(item.label, (count.get(item.label) || 0) + 1);
  return result.filter(item => count.get(item.label) === 1);
}

function matchesChoice(input: string, { brand, model, aliases }: VehicleChoice) {
  return [model, ...aliases].some(label => key(label) === input || key(brand + ' ' + label) === input);
}

export function findVehicleChoice(value: string, choices: VehicleChoice[]): VehicleChoice | undefined {
  const input = key(value);
  // Bare Atlas in an old source can refer to any of three workbook groups.
  if (input === 'atlas' || input === 'атлас') return undefined;
  return choices.find(model => matchesChoice(input, model));
}

export function requiresOkavangoYear(value: string): boolean {
  return /^(?:geely[\s-]*)?(?:ok[ao]vango|ок[ао]ванго)(?=$|[^\p{L}])/iu.test(value.trim());
}

export function actVehicleName(vehicle: string, group?: string): string {
  const input = key(vehicle);
  const match = models.find(model => model.group === group && matchesChoice(input, model)) ?? models.find(model => matchesChoice(input, model));
  if (match) return match.group === 'VG12' ? match.brand + ' MONJARO' : match.label;
  // Older Okavango orders can lack the model year. Retain a year only when the
  // order identifies one. Catalogue selection still uses its exact year range.
  const okavango = /^(?:geely[\s-]*)?(?:ok[ao]vango|ок[ао]ванго)(?:[\s-]+(\d{4}))?$/iu.exec(vehicle.trim());
  if (okavango) return okavango[1] ? 'GEELY OKAVANGO ' + okavango[1] : 'GEELY OKAVANGO';
  return vehicle.trim();
}

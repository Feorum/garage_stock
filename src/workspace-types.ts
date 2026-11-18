export interface Profile {
  id: string;
  name: string;
  color?: string;
  role: 'admin' | 'mechanic';
}
export type Navigate = (section: string, recordId?: string) => void;
export type Client = typeof import('./supabase.js').sb;

export function workshopDay(value: Date | string = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const field = (name: string) => parts.find((part) => part.type === name)?.value;
  return [field('year'), field('month'), field('day')].join('-');
}

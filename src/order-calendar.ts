import { workshopDay } from './workspace-types';

const weekdayNames = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function calendarDate(day: string | null | undefined) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(day + 'T00:00:00Z');
  return Number.isFinite(date.valueOf()) && date.toISOString().startsWith(day + 'T') ? date : null;
}

export function orderDay(order: { planned_date?: string | null; due_date?: string | null }) {
  if (order.planned_date && calendarDate(order.planned_date)) return order.planned_date;
  return order.due_date && calendarDate(order.due_date) ? order.due_date : '';
}

export function workshopOrderDay(instant?: string | null) {
  return instant ? workshopDay(instant) : '';
}

export function compareOrderDays(a: string | null | undefined, b: string | null | undefined) {
  return (a || '9999-99-99').localeCompare(b || '9999-99-99');
}

export function weekdayClass(day: string | null | undefined) {
  const weekday = calendarDate(day)?.getUTCDay();
  return weekday === undefined ? 'order-weekday' : `order-weekday order-weekday-${weekday || 7}`;
}

export function formatOrderDay(day: string | null | undefined) {
  const date = calendarDate(day);
  if (!date || !day) return '';
  return weekdayNames[date.getUTCDay()] + ', ' + day.split('-').reverse().join('.');
}

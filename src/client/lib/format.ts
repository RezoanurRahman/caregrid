/**
 * Date, time and number formatting for the clinic desk.
 *
 * All helpers are pure so they can be unit tested without a DOM. Calendar days are handled as
 * `YYYY-MM-DD` strings compared lexicographically, which keeps "overdue" logic immune to
 * timezone drift.
 */

import { toDateOnly, todayDateOnly } from '../normalize.js';

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export { toDateOnly, todayDateOnly };

/** Local date for a `YYYY-MM-DD` day, or null when the input is unusable. */
export function parseDateOnly(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addDays(dateOnly: string, days: number): string {
  const date = parseDateOnly(dateOnly);
  if (!date) {
    return dateOnly;
  }
  date.setDate(date.getDate() + days);
  return toDateOnly(date);
}

/** `Wed, Oct 7` – with Today/Tomorrow/Yesterday for the days around now. */
export function formatDayLabel(dateOnly: string, today: string = todayDateOnly()): string {
  if (!dateOnly) {
    return 'No date';
  }
  if (dateOnly === today) {
    return 'Today';
  }
  if (dateOnly === addDays(today, 1)) {
    return 'Tomorrow';
  }
  if (dateOnly === addDays(today, -1)) {
    return 'Yesterday';
  }
  const date = parseDateOnly(dateOnly);
  if (!date) {
    return dateOnly;
  }
  return `${WEEKDAYS_SHORT[date.getDay()]}, ${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}`;
}

/** `Wednesday, October 7, 2026` */
export function formatFullDate(dateOnly: string): string {
  const date = parseDateOnly(dateOnly);
  if (!date) {
    return dateOnly;
  }
  return `${WEEKDAYS_LONG[date.getDay()]}, ${MONTHS_LONG[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/** `9:00 AM`; unparseable input is echoed so nothing silently disappears. */
export function formatClock(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return value.trim();
  }
  const hours = Number(match[1]);
  const minutes = match[2];
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${minutes} ${suffix}`;
}

/** `9:00 – 9:30 AM` when the meridiem is shared, otherwise the full range. */
export function formatTimeRange(start: string, end: string): string {
  const from = formatClock(start);
  const to = formatClock(end);
  if (!from && !to) {
    return 'Time to be confirmed';
  }
  if (!to) {
    return from;
  }
  if (!from) {
    return to;
  }
  const fromSuffix = /(AM|PM)$/.exec(from)?.[1];
  const toSuffix = /(AM|PM)$/.exec(to)?.[1];
  if (fromSuffix && fromSuffix === toSuffix) {
    return `${from.replace(` ${fromSuffix}`, '')} – ${to}`;
  }
  return `${from} – ${to}`;
}

export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

export function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function formatRatio(booked: number, capacity: number): string {
  if (capacity <= 0) {
    return `${booked}`;
  }
  return `${booked} / ${capacity}`;
}

export function formatDuration(start: string, end: string): string {
  const from = /^(\d{1,2}):(\d{2})$/.exec(start.trim());
  const to = /^(\d{1,2}):(\d{2})$/.exec(end.trim());
  if (!from || !to) {
    return '';
  }
  const minutes = Number(to[1]) * 60 + Number(to[2]) - (Number(from[1]) * 60 + Number(from[2]));
  if (minutes <= 0) {
    return '';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** Calendar-day comparison; empty due dates are never overdue. */
export function isPastDue(dueDate: string, today: string = todayDateOnly()): boolean {
  return dueDate !== '' && dueDate < today;
}

/** `Oct 7, 2026 · 9:00 AM` for timeline stamps, empty when unparseable. */
export function formatTimestamp(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    return '';
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return formatDayLabel(trimmed);
  }
  const day = `${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${day} · ${display}:${minutes} ${suffix}`;
}

export function initials(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** Whole days from `today` to `dateOnly`; negative when the date has passed. */
export function daysUntil(dateOnly: string, today: string = todayDateOnly()): number {
  const target = parseDateOnly(dateOnly);
  const base = parseDateOnly(today);
  if (!target || !base) {
    return 0;
  }
  const day = 24 * 60 * 60 * 1000;
  return Math.round((target.getTime() - base.getTime()) / day);
}

/** `3 days overdue`, `Due today`, `Due in 2 days`. */
export function dueLabel(dueDate: string, today: string = todayDateOnly()): string {
  if (!dueDate) {
    return 'No due date';
  }
  const days = daysUntil(dueDate, today);
  if (days < 0) {
    const overdue = Math.abs(days);
    return overdue === 1 ? '1 day overdue' : `${overdue} days overdue`;
  }
  if (days === 0) {
    return 'Due today';
  }
  if (days === 1) {
    return 'Due tomorrow';
  }
  return `Due in ${days} days`;
}

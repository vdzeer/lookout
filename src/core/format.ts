import type { Translate } from './i18n';

const pad = (n: number) => String(n).padStart(2, '0');

/** How long something has been running, to the second while it is short: "45s", "1m 03s", "2h 05m". */
export function formatDuration(ms: number, t: Translate): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t('durationS', s);
  const m = Math.floor(s / 60);
  if (m < 60) return t('durationMS', m, pad(s % 60));
  const h = Math.floor(m / 60);
  if (h < 24) return t('durationHM', h, pad(m % 60));
  return t('durationDH', Math.floor(h / 24), h % 24);
}

/** Coarser, for how long ago: "12m", "3h". */
export function formatAge(ms: number, t: Translate): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t('ageS', s);
  const m = Math.floor(s / 60);
  if (m < 60) return t('ageM', m);
  const h = Math.floor(m / 60);
  if (h < 24) return t('ageH', h);
  return t('ageD', Math.floor(h / 24));
}

/** A clock time; with the weekday when it is not today. */
export function formatClock(at: number, now: number, locale: string, timeZone?: string): string {
  const sameDay = dayKey(at, locale, timeZone) === dayKey(now, locale, timeZone);
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(at);
}

function dayKey(at: number, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric', timeZone }).format(at);
}

/** Ten cells for a percentage, for plain-text tooltips. */
export function bar(percent: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

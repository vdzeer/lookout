// Claude Code gives its status line command a JSON with `rate_limits`:
// `{ five_hour: { used_percentage, resets_at }, seven_day: { ... } }`, with
// `resets_at` in epoch seconds. Lookout's status line step keeps the last
// such input in a file; this reads the limits out of it.

export type LimitName = 'fiveHour' | 'weekly';

export interface LimitWindow {
  usedPercent: number;
  /** When the window resets (ms). */
  resetsAt: number;
}

export interface Limits {
  fiveHour: LimitWindow | undefined;
  weekly: LimitWindow | undefined;
  /** When a session last reported them (ms): the file's modification time. */
  updatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (value.trim() !== '' && Number.isFinite(numeric)) return toMs(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toPercent(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, n));
}

function parseWindow(value: unknown): LimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = toPercent(value.used_percentage ?? value.utilization);
  const resetsAt = toMs(value.resets_at);
  if (usedPercent === undefined || resetsAt === undefined) return undefined;
  return { usedPercent, resetsAt };
}

/** Undefined when the input has no usable `rate_limits` (an API key account, or not yet reported). */
export function parseStatusLineInput(content: string, updatedAt: number): Limits | undefined {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(data) || !isRecord(data.rate_limits)) return undefined;
  const fiveHour = parseWindow(data.rate_limits.five_hour);
  const weekly = parseWindow(data.rate_limits.seven_day);
  if (!fiveHour && !weekly) return undefined;
  return { fiveHour, weekly, updatedAt };
}

export interface Effective {
  usedPercent: number;
  resetsAt: number;
  /** The reset time has passed since the last report: the window starts over at 0%. */
  isReset: boolean;
}

export function effective(window: LimitWindow, now: number): Effective {
  if (now >= window.resetsAt) return { usedPercent: 0, resetsAt: window.resetsAt, isReset: true };
  return { usedPercent: window.usedPercent, resetsAt: window.resetsAt, isReset: false };
}

export type LimitLevel = 'normal' | 'warning' | 'error';

/** Warning from the lowest threshold, error from the highest one (when there are two or more). */
export function levelOf(percent: number, thresholds: readonly number[]): LimitLevel {
  const sorted = cleanThresholds(thresholds);
  const low = sorted[0];
  const high = sorted.length > 1 ? sorted[sorted.length - 1] : undefined;
  if (high !== undefined && percent >= high) return 'error';
  if (low !== undefined && percent >= low) return 'warning';
  return 'normal';
}

export function cleanThresholds(thresholds: readonly unknown[]): number[] {
  const numbers = thresholds.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= 100);
  return [...new Set(numbers)].sort((a, b) => a - b);
}

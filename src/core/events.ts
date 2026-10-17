import { cleanThresholds, effective, type LimitName, type Limits, type LimitWindow } from './limits';
import type { Session } from './places';

// What is worth a notification between two looks at the sessions and limits.
// Every window compares its own previous look with the current one; the
// event keys are the same in every window, so a claim file can pick one
// window to show each event.

export interface Observation {
  sessions: ReadonlyMap<string, Session>;
  limits: Limits | undefined;
  now: number;
}

export interface NotifySettings {
  needsYou: boolean;
  finished: boolean;
  finishedAfterMs: number;
  limitNear: boolean;
  limitReset: boolean;
  thresholds: readonly number[];
}

export type LookoutEvent =
  | { kind: 'needsYou'; key: string; session: Session }
  | { kind: 'finished'; key: string; session: Session; durationMs: number }
  | { kind: 'limitNear'; key: string; limit: LimitName; usedPercent: number; resetsAt: number }
  | { kind: 'limitReset'; key: string; limit: LimitName };

export function observe(sessions: readonly Session[], limits: Limits | undefined, now: number): Observation {
  return { sessions: new Map(sessions.map((s) => [s.sessionId, s])), limits, now };
}

/** Nothing is reported for the first look: a window that just opened has no "before". */
export function detectEvents(before: Observation | undefined, after: Observation, settings: NotifySettings): LookoutEvent[] {
  if (!before) return [];
  const events: LookoutEvent[] = [];

  for (const session of after.sessions.values()) {
    const previous = before.sessions.get(session.sessionId);
    if (session.state === 'waiting' && settings.needsYou) {
      const already = previous?.state === 'waiting' && previous.since === session.since;
      if (!already) events.push({ kind: 'needsYou', key: `needsYou:${session.sessionId}:${session.since}`, session });
    }
    if (session.state === 'idle' && previous?.state === 'working' && settings.finished) {
      const end = session.since > previous.since ? session.since : after.now;
      const durationMs = end - previous.since;
      if (durationMs >= settings.finishedAfterMs) {
        events.push({ kind: 'finished', key: `finished:${session.sessionId}:${previous.since}`, session, durationMs });
      }
    }
  }

  const thresholds = cleanThresholds(settings.thresholds);
  for (const limit of ['fiveHour', 'weekly'] as const) {
    const was = before.limits?.[limit];
    const is = after.limits?.[limit] ?? was;
    if (!was || !is) continue;
    const old = effective(was, before.now);
    const now = effective(is, after.now);
    if (settings.limitNear) {
      const crossed = thresholds.filter((t) => old.usedPercent < t && now.usedPercent >= t);
      const top = crossed[crossed.length - 1];
      if (top !== undefined) {
        events.push({ kind: 'limitNear', key: `limitNear:${limit}:${top}:${now.resetsAt}`, limit, usedPercent: now.usedPercent, resetsAt: now.resetsAt });
      }
    }
    const top = thresholds[thresholds.length - 1];
    if (settings.limitReset && top !== undefined && !old.isReset && old.usedPercent >= top && hasReset(was, is, now.isReset)) {
      events.push({ kind: 'limitReset', key: `limitReset:${limit}:${was.resetsAt}`, limit });
    }
  }
  return events;
}

/** The window started over: its reset time passed, or a session reported the next window. */
function hasReset(was: LimitWindow, is: LimitWindow, passed: boolean): boolean {
  return passed || is.resetsAt > was.resetsAt;
}

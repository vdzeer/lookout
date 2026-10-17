import * as path from 'node:path';

// Claude Code keeps one file per running session in `<config>/sessions/<pid>.json`.
// The format is internal to Claude Code and can change with any release, so
// every field is checked and anything unexpected is dropped or marked unknown.

export type SessionState = 'working' | 'waiting' | 'idle' | 'unknown';

export interface SessionFile {
  pid: number;
  sessionId: string;
  /** Claude Code's own session name, else the folder name. */
  name: string;
  cwd: string;
  state: SessionState;
  /** What a waiting session waits for, in Claude Code's words ("input needed"). */
  waitingFor: string | undefined;
  /** When the current state began (ms). */
  since: number;
  /** A background job rather than a session in a terminal. */
  background: boolean;
  entrypoint: string | undefined;
  /** Process start in UTC, as `TZ=UTC LC_ALL=C ps -o lstart=` prints it. */
  procStart: string | undefined;
}

const STATES: Record<string, SessionState> = {
  busy: 'working',
  shell: 'working',
  waiting: 'waiting',
  idle: 'idle',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);
const time = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/** Session files are named after the pid: `1234.json`. Other files there are Claude Code's own. */
export function isSessionFileName(fileName: string): boolean {
  return /^\d+\.json$/.test(fileName);
}

/** `'daemon'` for the background job supervisor's own file, undefined for anything unreadable. */
export function parseSessionFile(fileName: string, content: string): SessionFile | 'daemon' | undefined {
  if (!isSessionFileName(fileName)) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  const kind = text(data.kind);
  // The daemon supervises background jobs; it is not a session.
  if (kind === 'daemon') return 'daemon';
  const pid = typeof data.pid === 'number' && Number.isInteger(data.pid) && data.pid > 0 ? data.pid : Number.parseInt(fileName, 10);
  const sessionId = text(data.sessionId);
  if (!sessionId || !Number.isInteger(pid) || pid <= 0) return undefined;
  const cwd = text(data.cwd) ?? '';
  const raw = text(data.status);
  const state = raw === undefined ? 'unknown' : (STATES[raw] ?? 'unknown');
  return {
    pid,
    sessionId,
    name: (text(data.name) ?? path.basename(cwd)) || `claude ${pid}`,
    cwd,
    state,
    waitingFor: state === 'waiting' ? text(data.waitingFor) : undefined,
    since: time(data.statusUpdatedAt) ?? time(data.updatedAt) ?? time(data.startedAt) ?? 0,
    background: kind === 'bg' || kind === 'daemon-worker',
    entrypoint: text(data.entrypoint),
    procStart: text(data.procStart),
  };
}

import * as fs from 'node:fs';
import * as path from 'node:path';

// Every editor window with Lookout writes a small record about itself, so the
// windows can tell which of them a session runs in, which one is in front,
// and hand each other a "show this session".

export interface WindowRecord {
  /** The window's extension host process; sessions started by extensions descend from it. */
  pid: number;
  /** The editor's name, "Antigravity IDE" or "Visual Studio Code". */
  app: string;
  /** What the window shows: the workspace or folder name. */
  name: string;
  folders: string[];
  workspaceFile: string | undefined;
  focused: boolean;
  /** Shell processes of the window's terminals. */
  shells: number[];
  /** When the record was written (ms). */
  at: number;
}

/** A record older than this belongs to a window that closed or hangs. */
export const WINDOW_STALE_MS = 20_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const positiveInts = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 1) : [];
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : []);

export function parseWindowRecord(content: string): WindowRecord | undefined {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(data) || typeof data.pid !== 'number' || !Number.isInteger(data.pid) || data.pid <= 1) return undefined;
  if (typeof data.at !== 'number') return undefined;
  return {
    pid: data.pid,
    app: typeof data.app === 'string' ? data.app : '',
    name: typeof data.name === 'string' ? data.name : '',
    folders: strings(data.folders),
    workspaceFile: typeof data.workspaceFile === 'string' ? data.workspaceFile : undefined,
    focused: data.focused === true,
    shells: positiveInts(data.shells),
    at: data.at,
  };
}

export function isFresh(record: WindowRecord, now: number): boolean {
  return now - record.at <= WINDOW_STALE_MS;
}

export function writeWindowRecord(dir: string, record: WindowRecord): void {
  writeFileAtomic(path.join(dir, `${record.pid}.json`), JSON.stringify(record));
}

export function readWindowRecords(dir: string): WindowRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records: WindowRecord[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const record = parseWindowRecord(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (record) records.push(record);
    } catch {
      // Removed while reading: the window closed.
    }
  }
  return records;
}

/** Writes through a temporary file and a rename, so readers never see half a file. */
export function writeFileAtomic(file: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { mode });
  fs.renameSync(temp, file);
}

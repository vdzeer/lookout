import { execFile } from 'node:child_process';
import * as path from 'node:path';

// One `ps` call gives every process with its parent, start time and
// executable. That answers three questions about a session's pid: is it
// still the same process, which editor window or terminal app it runs in,
// and which of this window's terminals is its ancestor.

export interface Proc {
  pid: number;
  ppid: number;
  /** Start time in UTC, `Sat Oct 17 11:00:54 2026`. */
  start: string;
  /** Full executable path on macOS, the short name on Linux. */
  command: string;
}

export type ProcessTable = Map<number, Proc>;

const LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

export function parsePs(output: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of output.split('\n')) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, pid, ppid, start, command] = match;
    table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), start: normalizeStart(start ?? ''), command: (command ?? '').trim() });
  }
  return table;
}

export function normalizeStart(start: string): string {
  return start.trim().replace(/\s+/g, ' ');
}

export function readProcesses(): Promise<ProcessTable> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,lstart=,comm='],
      { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(parsePs(stdout))),
    );
  });
}

/** The process is still the one that wrote the session file (pids get reused). */
export function isSameProcess(table: ProcessTable, pid: number, procStart: string | undefined): boolean {
  const proc = table.get(pid);
  if (!proc) return false;
  return procStart === undefined || proc.start === normalizeStart(procStart);
}

/** The pid itself, its parent, and so on up to the root. */
export function ancestry(table: ProcessTable, pid: number): number[] {
  const chain: number[] = [];
  let current: number | undefined = pid;
  while (current !== undefined && current > 1 && !chain.includes(current)) {
    chain.push(current);
    current = table.get(current)?.ppid;
  }
  return chain;
}

export interface App {
  name: string;
  /** The `.app` bundle on macOS, for `open -a`. */
  bundle: string | undefined;
}

const LINUX_TERMINALS = new Set([
  'gnome-terminal-server',
  'gnome-terminal-',
  'konsole',
  'kitty',
  'alacritty',
  'wezterm-gui',
  'ghostty',
  'tilix',
  'terminator',
  'xfce4-terminal',
  'foot',
  'xterm',
  'urxvt',
  'tmux: server',
  'code',
  'cursor',
  'windsurf',
]);

/** The app a session runs in: the nearest ancestor inside a `.app` bundle, or a known Linux terminal. */
export function appOf(table: ProcessTable, chain: number[]): App | undefined {
  for (const pid of chain) {
    const command = table.get(pid)?.command;
    if (!command) continue;
    const segments = command.split('/');
    const index = segments.findIndex((segment) => segment.endsWith('.app'));
    if (index >= 0) {
      const segment = segments[index] ?? '';
      return { name: segment.slice(0, -'.app'.length), bundle: segments.slice(0, index + 1).join('/') };
    }
    const base = path.basename(command);
    if (LINUX_TERMINALS.has(base)) return { name: base, bundle: undefined };
  }
  return undefined;
}

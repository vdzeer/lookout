import { ancestry, appOf, type App, type ProcessTable } from './processes';
import type { SessionFile } from './sessions';
import type { WindowRecord } from './windows';

// Where a session runs, seen from one editor window.

export type Place =
  /** In one of this window's terminals. */
  | { kind: 'thisTerminal'; shell: number; terminalName: string }
  /** Under this window's extension host: a Terminal Grid tile, Claude Code's panel or another extension's terminal. */
  | { kind: 'thisHost'; panel: boolean }
  | { kind: 'otherWindow'; window: WindowRecord }
  | { kind: 'outside'; app: App | undefined }
  | { kind: 'background' };

export interface Session extends SessionFile {
  place: Place;
}

export interface ThisWindow {
  hostPid: number;
  /** Shell pid → terminal name, for this window's terminals. */
  shells: ReadonlyMap<number, string>;
}

/** Claude Code started from a terminal says `cli`; its own panel and other hosts say something else. */
const isPanelSession = (session: SessionFile) => session.entrypoint !== undefined && session.entrypoint !== 'cli';

export function placeOf(session: SessionFile, table: ProcessTable, here: ThisWindow, others: readonly WindowRecord[]): Place {
  if (session.background) return { kind: 'background' };
  const chain = ancestry(table, session.pid);
  for (const pid of chain) {
    const terminalName = here.shells.get(pid);
    if (terminalName !== undefined) return { kind: 'thisTerminal', shell: pid, terminalName };
  }
  if (chain.includes(here.hostPid)) return { kind: 'thisHost', panel: isPanelSession(session) };
  for (const window of others) {
    if (window.pid === here.hostPid) continue;
    if (chain.includes(window.pid) || window.shells.some((shell) => chain.includes(shell))) return { kind: 'otherWindow', window };
  }
  return { kind: 'outside', app: appOf(table, chain.slice(1)) };
}

export const isThisWindow = (place: Place) => place.kind === 'thisTerminal' || place.kind === 'thisHost';

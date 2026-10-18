import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Paths } from './paths';
import { isTapLeftover, parseSettings, parseSetupRecord, serializeSettings, TAP_SCRIPT, tapCommand, tapStatus, withoutTap, withTap, type SetupRecord } from './tap';
import { writeFileAtomic } from './windows';

// Adding and removing the status line step on disk. Only `statusLine` in
// Claude Code's user settings is ever changed, and only after the user said
// yes in the editor.

export type SetupResult = { ok: true } | { ok: false; reason: 'unsupported' | 'unreadable' | 'unwritable'; detail: string };

const readIfExists = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

export function readSetup(paths: Paths): SetupRecord | undefined {
  const content = readIfExists(paths.setup);
  return content === undefined ? undefined : parseSetupRecord(content);
}

export type TapHealth = 'notSetUp' | 'ok' | 'changed';

/** Set up and still in place, set up but the user's status line replaced it since, or never set up. */
export function tapHealth(paths: Paths): TapHealth {
  if (!readSetup(paths)) return 'notSetUp';
  try {
    const status = tapStatus(parseSettings(readIfExists(paths.settings)), tapCommand(paths.tapScript));
    return status.kind === 'tapped' ? 'ok' : 'changed';
  } catch {
    return 'changed';
  }
}

export function installTap(paths: Paths, now = Date.now()): SetupResult {
  let previous: string | undefined;
  let settings: Record<string, unknown>;
  try {
    previous = readIfExists(paths.settings);
    settings = parseSettings(previous);
  } catch (error) {
    return { ok: false, reason: 'unreadable', detail: (error as Error).message };
  }
  const tap = tapCommand(paths.tapScript);
  const status = tapStatus(settings, tap);
  if (status.kind === 'unsupported') return { ok: false, reason: 'unsupported', detail: '' };
  // Already in place (set up from another editor): keep the command it wraps.
  const original = status.kind === 'command' ? status.command : status.kind === 'tapped' ? readSetup(paths)?.original : undefined;
  try {
    fs.mkdirSync(paths.lookout, { recursive: true, mode: 0o700 });
    writeFileAtomic(paths.tapScript, TAP_SCRIPT, 0o700);
    writeFileAtomic(paths.tapCommandFile, original ?? '');
    const record: SetupRecord = { version: 1, original, at: now };
    writeFileAtomic(paths.setup, JSON.stringify(record, null, 2));
    if (status.kind !== 'tapped') {
      if (previous !== undefined) writeFileAtomic(paths.settingsBackup, previous);
      writeSettings(paths.settings, serializeSettings(withTap(settings, tap), previous));
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'unwritable', detail: (error as Error).message };
  }
}

export type RemoveResult = { ok: true; removed: boolean } | { ok: false; reason: 'unreadable' | 'unwritable'; detail: string };

/** Puts the user's command back (or removes the status line Lookout added) and forgets the setup. */
export function removeTap(paths: Paths): RemoveResult {
  const setup = readSetup(paths);
  let previous: string | undefined;
  let settings: Record<string, unknown>;
  try {
    previous = readIfExists(paths.settings);
    settings = parseSettings(previous);
  } catch (error) {
    return { ok: false, reason: 'unreadable', detail: (error as Error).message };
  }
  const tapped = tapStatus(settings, tapCommand(paths.tapScript)).kind === 'tapped';
  try {
    if (tapped) writeSettings(paths.settings, serializeSettings(withoutTap(settings, setup?.original), previous));
    for (const file of [paths.setup, paths.tapCommandFile, paths.tapInput, paths.tapScript]) fs.rmSync(file, { force: true });
    return { ok: true, removed: tapped || setup !== undefined };
  } catch (error) {
    return { ok: false, reason: 'unwritable', detail: (error as Error).message };
  }
}

/**
 * Keeps the file's permissions (settings.json may hold other tools' tokens)
 * and writes through a symlink rather than replacing it, for settings kept
 * in a dotfiles folder.
 */
function writeSettings(file: string, content: string): void {
  let target = file;
  let mode = 0o600;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    // A new file.
  }
  writeFileAtomic(target, content, mode);
}

const LEFTOVER_MS = 60_000;

/**
 * Brings a script written by an earlier version up to date (0.1.0 kept the
 * input only after the user's command, so a cancelled run lost it) and
 * removes the inputs such runs left behind.
 */
export function updateTapScript(paths: Paths, now = Date.now()): void {
  try {
    if (readIfExists(paths.tapScript) !== TAP_SCRIPT) writeFileAtomic(paths.tapScript, TAP_SCRIPT, 0o700);
    for (const name of fs.readdirSync(paths.lookout).filter(isTapLeftover)) {
      const file = path.join(paths.lookout, name);
      if (now - fs.statSync(file).mtimeMs > LEFTOVER_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    // Tried again on the next start.
  }
}

/** The last status line input, when a session reported one. */
export function readTapInput(paths: Paths): { content: string; mtimeMs: number } | undefined {
  try {
    const stat = fs.statSync(paths.tapInput);
    return { content: fs.readFileSync(paths.tapInput, 'utf8'), mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

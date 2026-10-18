// The status line step. Claude Code runs `statusLine.command` from its
// `settings.json` with a JSON on stdin that includes the usage limits. With
// the user's yes, Lookout puts a small script in front of that command: it
// keeps the input in a file for the editor and then runs the user's own
// command with the same input, so the status line looks as before.

/** The script, written to `<config>/lookout/statusline.sh`. */
export const TAP_SCRIPT = `#!/bin/sh
# Lookout: keeps the Claude Code status line input for the editor's status
# bar, then runs your own status line command with the same input.
# Remove it with "Lookout: Remove Usage Limits" in the editor.
umask 077
dir=$(dirname "$0")
tmp="$dir/statusline.$$.tmp"
cat > "$tmp" || { rm -f "$tmp"; exit 0; }
# Kept before your command runs: Claude Code cancels a status line command
# that is still running when the next update comes.
exec < "$tmp"
mv -f "$tmp" "$dir/statusline.json"
[ -s "$dir/statusline-command" ] || exit 0
exec sh -c "$(cat "$dir/statusline-command")"
`;

/** What a status line run left behind when it was cancelled while reading its input. */
export const isTapLeftover = (name: string): boolean => /^statusline\.\d+\.tmp$/.test(name);

/** Single quotes for sh, safe for any path. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function tapCommand(scriptPath: string): string {
  return `sh ${shellQuote(scriptPath)}`;
}

type Settings = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type TapStatus =
  /** The status line runs Lookout's step. */
  | { kind: 'tapped' }
  /** No status line at all. */
  | { kind: 'none' }
  /** The user's own status line command. */
  | { kind: 'command'; command: string }
  /** A status line Lookout does not know how to wrap. */
  | { kind: 'unsupported' };

export function tapStatus(settings: Settings, tap: string): TapStatus {
  const line = settings.statusLine;
  if (line === undefined || line === null) return { kind: 'none' };
  if (!isRecord(line) || (line.type !== undefined && line.type !== 'command') || typeof line.command !== 'string') return { kind: 'unsupported' };
  if (line.command === tap) return { kind: 'tapped' };
  return { kind: 'command', command: line.command };
}

/** The settings with Lookout's step in place, keeping every other field of `statusLine`. */
export function withTap(settings: Settings, tap: string): Settings {
  const line = isRecord(settings.statusLine) ? settings.statusLine : {};
  return { ...settings, statusLine: { ...line, type: 'command', command: tap } };
}

/** The settings as they were: the original command back, or no status line when there was none. */
export function withoutTap(settings: Settings, original: string | undefined): Settings {
  if (original === undefined) {
    const rest = { ...settings };
    delete rest.statusLine;
    return rest;
  }
  const line = isRecord(settings.statusLine) ? settings.statusLine : {};
  return { ...settings, statusLine: { ...line, type: 'command', command: original } };
}

/** Parses settings.json; an empty or missing file is an empty object. */
export function parseSettings(content: string | undefined): Settings {
  if (content === undefined || content.trim() === '') return {};
  const data: unknown = JSON.parse(content);
  if (!isRecord(data)) throw new Error('settings.json does not hold a JSON object');
  return data;
}

/** Keeps the file's indentation (two spaces when it has none). */
export function serializeSettings(settings: Settings, previous: string | undefined): string {
  const indent = /\n([ \t]+)"/.exec(previous ?? '')?.[1] ?? '  ';
  return `${JSON.stringify(settings, null, indent)}\n`;
}

/** What Lookout remembers about the user's status line, in `<config>/lookout/setup.json`. */
export interface SetupRecord {
  version: 1;
  /** The command before Lookout's step; undefined when there was no status line. */
  original: string | undefined;
  at: number;
}

export function parseSetupRecord(content: string): SetupRecord | undefined {
  try {
    const data: unknown = JSON.parse(content);
    if (!isRecord(data) || data.version !== 1) return undefined;
    return {
      version: 1,
      original: typeof data.original === 'string' ? data.original : undefined,
      at: typeof data.at === 'number' ? data.at : 0,
    };
  } catch {
    return undefined;
  }
}

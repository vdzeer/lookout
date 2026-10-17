import * as os from 'node:os';
import * as path from 'node:path';

/** Claude Code's configuration folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(home, '.claude');
}

export interface Paths {
  config: string;
  settings: string;
  sessions: string;
  /** Lookout's own folder inside Claude Code's: shared by every editor window and profile. */
  lookout: string;
  tapScript: string;
  tapCommandFile: string;
  tapInput: string;
  setup: string;
  settingsBackup: string;
  windows: string;
  claims: string;
  requests: string;
  /** Muted notifications, shared by every window: `{ "until": <ms> }`. */
  mute: string;
}

export function pathsFor(config: string): Paths {
  const lookout = path.join(config, 'lookout');
  return {
    config,
    settings: path.join(config, 'settings.json'),
    sessions: path.join(config, 'sessions'),
    lookout,
    tapScript: path.join(lookout, 'statusline.sh'),
    tapCommandFile: path.join(lookout, 'statusline-command'),
    tapInput: path.join(lookout, 'statusline.json'),
    setup: path.join(lookout, 'setup.json'),
    settingsBackup: path.join(lookout, 'settings.backup.json'),
    windows: path.join(lookout, 'windows'),
    claims: path.join(lookout, 'claims'),
    requests: path.join(lookout, 'requests'),
    mute: path.join(lookout, 'mute.json'),
  };
}

/** `~/.claude/settings.json` rather than the full path, for messages. */
export function displayPath(file: string, home = os.homedir()): string {
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

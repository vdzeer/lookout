// Every UI string, English only. `{0}` style placeholders, no plural forms:
// counts are written so that one form fits every number.
const en = {
  // Status bar
  sessionsNone: 'No sessions',
  idleCount: '{0} idle',
  workingMany: '{0} working',
  needsYouOne: '{0} needs you',
  needsYouMany: 'Waiting for you: {0}',
  limitFiveHourShort: '5h {0}%',
  limitWeeklyShort: 'wk {0}%',
  limitResetsShort: 'resets {0}',
  limitsSetUpShort: 'Limits: set up',
  limitsWaitingShort: 'Limits: waiting',

  // Durations: compact, for the status bar and lists
  durationS: '{0}s',
  durationMS: '{0}m {1}s',
  durationHM: '{0}h {1}m',
  durationDH: '{0}d {1}h',
  ageS: '{0}s',
  ageM: '{0}m',
  ageH: '{0}h',
  ageD: '{0}d',

  // Tooltip
  tooltipTitle: 'Claude Code sessions',
  noSessions: 'No Claude Code sessions are running.',
  unsupportedFormat: 'This Claude Code version writes its session files in a format Lookout does not know yet.',
  groupThisWindow: 'This window',
  groupOtherWindow: 'Window: {0}',
  groupOutside: 'Outside the editor',
  groupBackground: 'Background',
  stateWorking: 'working {0}',
  stateNeedsYou: 'needs you: {0}',
  stateNeedsYouPlain: 'needs you',
  stateIdle: 'idle {0}',
  stateUnknown: 'state unknown',
  placeGrid: 'Terminal Grid',
  placeTerminal: '{0}, Terminal tab',
  placePanel: 'Claude Code panel',
  placeExtension: 'started by an extension',
  limitsTitle: 'Limits',
  limitFiveHour: '5-hour',
  limitWeekly: 'Weekly',
  limitLine: '{0}: {1}% · resets {2}',
  limitLineReset: '{0}: reset at {1}',
  limitsUpdated: 'Updated {0} ago',
  limitsUpdatedNow: 'Updated just now',
  limitsNotSetUp: 'Usage limits are not set up.',
  limitsNoData: 'No session has reported usage limits yet. They appear after the next Claude Code reply.',
  linkGoTo: 'Go to Session…',
  linkMute: 'Mute for 1 Hour',
  linkUnmute: 'Unmute',
  linkSettings: 'Settings',
  linkSetUp: 'Set Up Usage Limits',
  linkRemoveLimits: 'Remove Usage Limits',
  mutedUntil: 'Notifications are muted until {0}.',

  // Session list
  pickPlaceholder: 'Go to a Claude Code session',
  pickThisWindow: 'this window',
  pickOtherWindow: 'window {0}',
  pickNoTerminal: 'no terminal',

  // Notifications
  notifyNeedsYou: '{0} needs you: {1}.',
  notifyNeedsYouPlain: '{0} needs you.',
  notifyInWindow: '{0} Window {1}.',
  notifyFinished: '{0} finished after {1}.',
  notifyLimitNear: '{0} limit at {1}%. It resets at {2}.',
  notifyLimitReset: '{0} limit has reset.',
  show: 'Show',
  muteHour: 'Mute for 1 Hour',
  muted: 'Lookout notifications are muted until {0}.',
  unmuted: 'Lookout notifications are on again.',

  // Usage limits setup
  askSetUp:
    'Show your Claude Code usage limits in the status bar? Lookout adds a small step in front of your status line command in {0}. Your status line stays the same, and "Remove Usage Limits" puts it back exactly.',
  setUp: 'Set Up',
  notNow: 'Not Now',
  never: 'Never',
  setUpDone: 'Usage limits will show after the next Claude Code reply.',
  setUpAlready: 'Usage limits are already set up.',
  setUpUnsupported: 'Your status line in {0} is not a command, so Lookout cannot add its step to it.',
  settingsUnreadable: 'Lookout could not read {0}: {1}',
  settingsUnwritable: 'Lookout could not change {0}: {1}',
  askChanged:
    'Your Claude Code status line changed, so usage limits stopped updating. Keep showing them with the new status line?',
  keepShowing: 'Keep Showing',
  stop: 'Stop',
  removed: 'Your status line command is back as it was.',
  removeNothing: 'Usage limits are not set up.',

  // Going to a session
  revealGone: 'That session has ended.',
  revealNoTerminal: '{0} runs in the background and has no terminal.',
  revealOtherNoFolder: '{0} is in another window with no folder open. Switch to that window to see it.',
  revealOutside: '{0} runs in {1}.',
  revealOutsideUnknown: '{0} runs outside the editor.',
  notSupported: 'Lookout works on macOS and Linux.',
} as const;

export type MessageKey = keyof typeof en;

export type Translate = (key: MessageKey, ...args: (string | number)[]) => string;

export const t: Translate = (key, ...args) =>
  en[key].replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });

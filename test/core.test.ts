import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { claim, pruneClaims } from '../src/core/claims';
import { detectEvents, observe, type NotifySettings } from '../src/core/events';
import { formatAge, formatClock, formatDuration } from '../src/core/format';
import { t } from '../src/core/i18n';
import { cleanThresholds, effective, levelOf, parseStatusLineInput, type Limits } from '../src/core/limits';
import { claudeConfigDir, displayPath, pathsFor } from '../src/core/paths';
import { placeOf, type Session, type ThisWindow } from '../src/core/places';
import { ancestry, appOf, isSameProcess, parsePs } from '../src/core/processes';
import { parseSessionFile, type SessionFile } from '../src/core/sessions';
import { installTap, removeTap, tapHealth } from '../src/core/setupFiles';
import { parseSettings, serializeSettings, shellQuote, TAP_SCRIPT, tapCommand, tapStatus, withoutTap, withTap } from '../src/core/tap';
import { escapeMarkdown, groupSessions, limitsText, sessionsText, tooltipMarkdown, type ViewInput } from '../src/core/view';
import { isFresh, parseWindowRecord, type WindowRecord } from '../src/core/windows';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lookout-test-'));

// A session file as Claude Code 2.1.30x writes it.
const REAL = JSON.stringify({
  pid: 18172,
  sessionId: 'a1b2c3d4-0000-4000-8000-000000000001',
  cwd: '/Users/me/Projects',
  startedAt: 1792234855798,
  procStart: 'Sat Oct 17 11:00:54 2026',
  version: '2.1.301',
  kind: 'interactive',
  entrypoint: 'cli',
  name: 'projects-f7',
  nameSource: 'derived',
  status: 'busy',
  updatedAt: 1792239566030,
  statusUpdatedAt: 1792239566030,
});

const file = (overrides: Partial<SessionFile> = {}): SessionFile => ({
  pid: 100,
  sessionId: 's1',
  name: 'alpha',
  cwd: '/work/alpha',
  state: 'idle',
  waitingFor: undefined,
  since: 1000,
  background: false,
  entrypoint: 'cli',
  procStart: undefined,
  ...overrides,
});

const session = (overrides: Partial<Session> = {}): Session => ({ ...file(), place: { kind: 'thisHost', panel: false }, ...overrides });

describe('session files', () => {
  it('reads the fields Claude Code writes', () => {
    const parsed = parseSessionFile('18172.json', REAL);
    assert.ok(parsed && parsed !== 'daemon');
    assert.equal(parsed.pid, 18172);
    assert.equal(parsed.name, 'projects-f7');
    assert.equal(parsed.state, 'working');
    assert.equal(parsed.since, 1792239566030);
    assert.equal(parsed.background, false);
    assert.equal(parsed.procStart, 'Sat Oct 17 11:00:54 2026');
  });

  it('maps every status and keeps what a waiting session waits for', () => {
    const with_ = (status: string, extra = {}) => parseSessionFile('1.json', JSON.stringify({ pid: 1, sessionId: 'x', status, ...extra }));
    assert.equal((with_('shell') as SessionFile).state, 'working');
    assert.equal((with_('idle') as SessionFile).state, 'idle');
    assert.equal((with_('something-new') as SessionFile).state, 'unknown');
    const waiting = with_('waiting', { waitingFor: 'input needed' }) as SessionFile;
    assert.equal(waiting.state, 'waiting');
    assert.equal(waiting.waitingFor, 'input needed');
    assert.equal((with_('idle', { waitingFor: 'stale' }) as SessionFile).waitingFor, undefined);
  });

  it('tells the daemon, background jobs and broken files apart', () => {
    assert.equal(parseSessionFile('5.json', JSON.stringify({ pid: 5, sessionId: 'd', kind: 'daemon' })), 'daemon');
    assert.equal((parseSessionFile('6.json', JSON.stringify({ pid: 6, sessionId: 'b', kind: 'bg' })) as SessionFile).background, true);
    assert.equal((parseSessionFile('7.json', JSON.stringify({ pid: 7, sessionId: 'w', kind: 'daemon-worker' })) as SessionFile).background, true);
    assert.equal(parseSessionFile('8.json', '{not json'), undefined);
    assert.equal(parseSessionFile('9.json', JSON.stringify({ pid: 9 })), undefined);
    assert.equal(parseSessionFile('18172.16ca.key', REAL), undefined);
    assert.equal(parseSessionFile('10.json', '[]'), undefined);
  });

  it('falls back to the folder name, then the pid', () => {
    assert.equal((parseSessionFile('3.json', JSON.stringify({ sessionId: 'a', cwd: '/x/skarbnyk' })) as SessionFile).name, 'skarbnyk');
    assert.equal((parseSessionFile('3.json', JSON.stringify({ sessionId: 'a' })) as SessionFile).name, 'claude 3');
  });
});

const PS = [
  '    1     0 Sat Oct 17 07:00:00 2026 /sbin/launchd',
  '  500     1 Sat Oct 17 07:01:00 2026 /Applications/Antigravity IDE.app/Contents/MacOS/Electron',
  '  510   500 Sat Oct 17 07:01:05 2026 /Applications/Antigravity IDE.app/Contents/Frameworks/Antigravity IDE Helper (Plugin).app/Contents/MacOS/Antigravity IDE Helper (Plugin)',
  '  520   510 Sat Oct 17 08:00:00 2026 /bin/zsh',
  '  530   520 Sat Oct 17 11:00:54 2026 claude',
  '  600     1 Sat Oct 17 07:02:00 2026 /Applications/iTerm.app/Contents/MacOS/iTerm2',
  '  610   600 Sat Oct 17 07:03:00 2026 /usr/bin/login',
  '  620   610 Sat Oct 17 07:03:01 2026 -zsh',
  '  630   620 Sat Oct 17 09:00:00 2026 claude',
  '  700   500 Sat Oct 17 07:01:06 2026 /Applications/Antigravity IDE.app/Contents/Frameworks/Antigravity IDE Helper.app/Contents/MacOS/pty-host',
  '  710   700 Sat Oct 17 09:30:00 2026 /bin/zsh',
  '  720   710 Sat Oct 17 09:31:00 2026 claude',
  '  800     1 Sat Oct 17 07:04:00 2026 /usr/bin/gnome-terminal-server',
  '  810   800 Sat Oct 17 07:04:01 2026 bash',
  '  820   810 Sat Oct 17  9:05:00 2026 claude',
  'garbage line',
].join('\n');

describe('processes', () => {
  const table = parsePs(PS);

  it('parses ps output, start times with single-digit hours included', () => {
    assert.equal(table.size, 15);
    assert.equal(table.get(530)?.ppid, 520);
    assert.equal(table.get(820)?.start, 'Sat Oct 17 9:05:00 2026');
  });

  it('knows a reused pid from the process that wrote the session file', () => {
    assert.equal(isSameProcess(table, 530, 'Sat Oct 17 11:00:54 2026'), true);
    assert.equal(isSameProcess(table, 530, 'Sat  Oct 17 11:00:54 2026'), true);
    assert.equal(isSameProcess(table, 530, 'Fri Oct 16 11:00:54 2026'), false);
    assert.equal(isSameProcess(table, 999, undefined), false);
    assert.equal(isSameProcess(table, 530, undefined), true);
  });

  it('walks up to the root and names the app', () => {
    assert.deepEqual(ancestry(table, 530), [530, 520, 510, 500]);
    assert.deepEqual(appOf(table, ancestry(table, 630)), { name: 'iTerm', bundle: '/Applications/iTerm.app' });
    assert.deepEqual(appOf(table, ancestry(table, 530)), { name: 'Antigravity IDE', bundle: '/Applications/Antigravity IDE.app' });
    assert.deepEqual(appOf(table, ancestry(table, 820)), { name: 'gnome-terminal-server', bundle: undefined });
  });
});

describe('where a session runs', () => {
  const table = parsePs(PS);
  const here: ThisWindow = { hostPid: 510, shells: new Map([[710, 'zsh']]) };
  const other: WindowRecord = { pid: 900, app: 'Antigravity IDE', name: 'skarbnyk', folders: ['/w/skarbnyk'], workspaceFile: undefined, focused: false, shells: [620], at: 0 };

  it('in a terminal of this window', () => {
    assert.deepEqual(placeOf(file({ pid: 720 }), table, here, []), { kind: 'thisTerminal', shell: 710, terminalName: 'zsh' });
  });

  it('under this window: a Terminal Grid tile, or Claude Code’s own panel', () => {
    assert.deepEqual(placeOf(file({ pid: 530 }), table, here, []), { kind: 'thisHost', panel: false });
    assert.deepEqual(placeOf(file({ pid: 530, entrypoint: 'claude-vscode' }), table, here, []), { kind: 'thisHost', panel: true });
  });

  it('in another window, by its terminals or its extension host', () => {
    assert.equal(placeOf(file({ pid: 630 }), table, here, [other]).kind, 'otherWindow');
    const elsewhere: ThisWindow = { hostPid: 1234, shells: new Map() };
    const place = placeOf(file({ pid: 530 }), table, elsewhere, [{ ...other, pid: 510, shells: [] }]);
    assert.equal(place.kind === 'otherWindow' && place.window.name, 'skarbnyk');
  });

  it('outside the editor, and background jobs', () => {
    const place = placeOf(file({ pid: 630 }), table, here, []);
    assert.equal(place.kind === 'outside' && place.app?.name, 'iTerm');
    assert.deepEqual(placeOf(file({ pid: 630, background: true }), table, here, [other]), { kind: 'background' });
  });
});

describe('usage limits', () => {
  const input = (limits: unknown) => JSON.stringify({ session_id: 'x', rate_limits: limits });

  it('reads the status line input, resets in seconds or as dates', () => {
    const limits = parseStatusLineInput(
      input({ five_hour: { used_percentage: 34.4, resets_at: 1792252860 }, seven_day: { used_percentage: '41', resets_at: '2026-10-22T07:00:00Z' } }),
      5,
    );
    assert.deepEqual(limits, {
      fiveHour: { usedPercent: 34.4, resetsAt: 1792252860000 },
      weekly: { usedPercent: 41, resetsAt: Date.parse('2026-10-22T07:00:00Z') },
      updatedAt: 5,
    });
  });

  it('ignores inputs without limits', () => {
    assert.equal(parseStatusLineInput('{"model":{}}', 1), undefined);
    assert.equal(parseStatusLineInput(input({ five_hour: { used_percentage: 'x', resets_at: 1 } }), 1), undefined);
    assert.equal(parseStatusLineInput('nope', 1), undefined);
    assert.equal(parseStatusLineInput(input({ seven_day: { used_percentage: 150, resets_at: 1792252860 } }), 1)?.weekly?.usedPercent, 100);
  });

  it('starts a window over once its reset time passed', () => {
    assert.deepEqual(effective({ usedPercent: 90, resetsAt: 100 }, 99), { usedPercent: 90, resetsAt: 100, isReset: false });
    assert.deepEqual(effective({ usedPercent: 90, resetsAt: 100 }, 100), { usedPercent: 0, resetsAt: 100, isReset: true });
  });

  it('colours by thresholds', () => {
    assert.equal(levelOf(79, [80, 95]), 'normal');
    assert.equal(levelOf(80, [95, 80]), 'warning');
    assert.equal(levelOf(95, [80, 95]), 'error');
    assert.equal(levelOf(99, [80]), 'warning');
    assert.equal(levelOf(99, []), 'normal');
    assert.deepEqual(cleanThresholds([95, 'x', 80, 0, 101, 80]), [80, 95]);
  });
});

describe('formatting', () => {
  it('durations and ages', () => {
    assert.equal(formatDuration(45_000, t), '45s');
    assert.equal(formatDuration(63_000, t), '1m 03s');
    assert.equal(formatDuration(2 * 3600_000 + 5 * 60_000, t), '2h 05m');
    assert.equal(formatDuration(-5, t), '0s');
    assert.equal(formatAge(12 * 60_000 + 59_000, t), '12m');
    assert.equal(formatAge(3 * 86400_000, t), '3d');
  });

  it('clock times, with the weekday when not today', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    assert.equal(formatClock(Date.parse('2026-10-17T19:01:00Z'), now, 'en-GB', 'UTC'), '19:01');
    assert.equal(formatClock(Date.parse('2026-10-22T10:00:00Z'), now, 'en-GB', 'UTC'), 'Thu 10:00');
  });
});

const view = (overrides: Partial<ViewInput> = {}): ViewInput => ({
  sessions: [],
  limits: undefined,
  limitsSetUp: true,
  thresholds: [80, 95],
  showWeekly: true,
  gridInstalled: true,
  unsupported: false,
  mutedUntil: undefined,
  now: 100_000,
  locale: 'en-GB',
  t,
  ...overrides,
});

describe('status bar text', () => {
  it('nothing, idle, one working, several working', () => {
    assert.deepEqual(sessionsText(view()), { text: '$(circle-outline) No sessions', level: 'none' });
    assert.equal(sessionsText(view({ sessions: [session(), session({ sessionId: 's2' })] })).text, '$(circle-outline) 2 idle');
    assert.equal(sessionsText(view({ sessions: [session({ state: 'working', since: 37_000 })] })).text, '$(loading~spin) alpha · 1m 03s');
    const many = [session({ state: 'working', since: 90_000 }), session({ sessionId: 's2', state: 'working', since: 10_000 }), session({ sessionId: 's3' })];
    assert.deepEqual(sessionsText(view({ sessions: many })), { text: '$(loading~spin) 2 working · 1m 30s', level: 'working' });
  });

  it('a session waiting for you comes first', () => {
    const one = [session({ state: 'waiting', name: 'skarbnyk' }), session({ sessionId: 's2', state: 'working' })];
    assert.deepEqual(sessionsText(view({ sessions: one })), { text: '$(bell-dot) skarbnyk needs you · 1 working', level: 'waiting' });
    const two = [session({ state: 'waiting' }), session({ sessionId: 's2', state: 'waiting' })];
    assert.equal(sessionsText(view({ sessions: two })).text, '$(bell-dot) Waiting for you: 2');
  });

  it('limits: not set up, waiting for data, normal, warning, error with the reset time', () => {
    assert.deepEqual(limitsText(view({ limitsSetUp: false })), { text: '$(dashboard) Limits: set up', level: 'unknown' });
    assert.equal(limitsText(view()).text, '$(dashboard) Limits: waiting');
    const now = Date.parse('2026-10-17T12:00:00Z');
    const limits = (five: number, week: number): Limits => ({
      fiveHour: { usedPercent: five, resetsAt: Date.parse('2026-10-17T19:01:00Z') },
      weekly: { usedPercent: week, resetsAt: Date.parse('2026-10-22T10:00:00Z') },
      updatedAt: now,
    });
    assert.deepEqual(limitsText(view({ now, limits: limits(34.4, 41) })), { text: '$(dashboard) 5h 34% · wk 41%', level: 'normal' });
    assert.equal(limitsText(view({ now, limits: limits(34, 41), showWeekly: false })).text, '$(dashboard) 5h 34%');
    assert.equal(limitsText(view({ now, limits: limits(86, 41) })).level, 'warning');
    const error = limitsText(view({ now, limits: limits(97, 41) }));
    assert.equal(error.level, 'error');
    assert.match(error.text, /^\$\(dashboard\) 5h 97% · resets \d/);
    assert.equal(limitsText(view({ now: Date.parse('2026-10-17T19:02:00Z'), limits: limits(97, 41) })).text, '$(dashboard) 5h 0% · wk 41%');
  });
});

describe('tooltip', () => {
  const other: WindowRecord = { pid: 900, app: 'A', name: 'skarbnyk', folders: [], workspaceFile: undefined, focused: false, shells: [], at: 0 };
  const sessions: Session[] = [
    session({ sessionId: 'bg', name: 'nightly', place: { kind: 'background' }, state: 'working' }),
    session({ sessionId: 'out', name: 'everhue', place: { kind: 'outside', app: { name: 'iTerm', bundle: undefined } } }),
    session({ sessionId: 'win', name: 'skar[b]nyk', place: { kind: 'otherWindow', window: other }, state: 'waiting', waitingFor: 'input needed' }),
    session({ sessionId: 'here', name: 'projects-f7', state: 'working', since: 37_000 }),
  ];

  it('groups this window, other windows, outside, background', () => {
    assert.deepEqual(
      groupSessions(sessions, t).map((g) => g.title),
      ['This window', 'Window: skarbnyk', 'Outside the editor', 'Background'],
    );
  });

  it('links sessions, escapes names, lists limits and actions', () => {
    const markdown = tooltipMarkdown(view({ sessions, limitsSetUp: false }));
    assert.match(markdown, /\[projects\\-f7\]\(command:lookout\.reveal\?%5B%22here%22%5D\)/);
    assert.match(markdown, /skar\\\[b\\\]nyk/);
    assert.match(markdown, /needs you: input needed/);
    assert.doesNotMatch(markdown, /command:lookout\.reveal\?%5B%22bg%22%5D/);
    assert.match(markdown, /Usage limits are not set up/);
    assert.match(markdown, /command:lookout\.setUpLimits/);
  });

  it('escapes Markdown and icon syntax', () => {
    assert.equal(escapeMarkdown('$(alert) [x](y)'), '\\$\\(alert\\) \\[x\\]\\(y\\)');
  });
});

const settings: NotifySettings = { needsYou: true, finished: true, finishedAfterMs: 60_000, limitNear: true, limitReset: true, thresholds: [80, 95] };

describe('notification events', () => {
  it('nothing on the first look', () => {
    assert.deepEqual(detectEvents(undefined, observe([session({ state: 'waiting' })], undefined, 0), settings), []);
  });

  it('a session starts waiting: once per waiting spell', () => {
    const before = observe([session({ state: 'working', since: 1 })], undefined, 10);
    const after = observe([session({ state: 'waiting', since: 5 })], undefined, 20);
    const events = detectEvents(before, after, settings);
    assert.deepEqual(events.map((e) => e.key), ['needsYou:s1:5']);
    assert.deepEqual(detectEvents(after, observe([session({ state: 'waiting', since: 5 })], undefined, 30), settings), []);
    assert.equal(detectEvents(after, observe([session({ state: 'waiting', since: 40 })], undefined, 50), settings).length, 1);
    assert.deepEqual(detectEvents(before, after, { ...settings, needsYou: false }), []);
  });

  it('a long turn ends', () => {
    const before = observe([session({ state: 'working', since: 0 })], undefined, 100_000);
    const done = observe([session({ state: 'idle', since: 90_000 })], undefined, 100_500);
    const events = detectEvents(before, done, settings);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind === 'finished' && events[0].durationMs, 90_000);
    const short = observe([session({ state: 'idle', since: 30_000 })], undefined, 31_000);
    assert.deepEqual(detectEvents(before, short, settings), []);
  });

  const limits = (five: number, resetsAt = 1_000_000): Limits => ({ fiveHour: { usedPercent: five, resetsAt }, weekly: undefined, updatedAt: 0 });

  it('a limit crosses a threshold: the highest one crossed', () => {
    const events = detectEvents(observe([], limits(70), 0), observe([], limits(96), 1), settings);
    assert.deepEqual(events.map((e) => e.key), ['limitNear:fiveHour:95:1000000']);
    assert.deepEqual(detectEvents(observe([], limits(81), 0), observe([], limits(90), 1), settings), []);
  });

  it('a limit that reached the top resets', () => {
    const near = observe([], limits(97), 0);
    assert.deepEqual(detectEvents(near, observe([], limits(97), 1_000_001), settings).map((e) => e.key), ['limitReset:fiveHour:1000000']);
    assert.deepEqual(detectEvents(near, observe([], limits(3, 2_000_000), 10), settings).map((e) => e.kind), ['limitReset']);
    assert.deepEqual(detectEvents(observe([], limits(50), 0), observe([], limits(50), 1_000_001), settings), []);
  });
});

describe('claims', () => {
  it('one window wins each event', () => {
    const dir = tmp();
    assert.equal(claim(dir, 'needsYou:s1:5'), true);
    assert.equal(claim(dir, 'needsYou:s1:5'), false);
    assert.equal(claim(dir, 'needsYou:s1:6'), true);
    pruneClaims(dir, 60_000, Date.now() + 120_000);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

describe('window records', () => {
  it('parses and ages them', () => {
    const record = parseWindowRecord(JSON.stringify({ pid: 42, app: 'A', name: 'n', folders: ['/a', 3], focused: true, shells: [7, 'x', 1], at: 1000 }));
    assert.deepEqual(record, { pid: 42, app: 'A', name: 'n', folders: ['/a'], workspaceFile: undefined, focused: true, shells: [7], at: 1000 });
    assert.equal(isFresh(record as WindowRecord, 21_000), true);
    assert.equal(isFresh(record as WindowRecord, 21_001), false);
    assert.equal(parseWindowRecord('{"pid":1,"at":1}'), undefined);
  });
});

describe('status line step', () => {
  const tap = tapCommand('/home/me/.claude/lookout/statusline.sh');

  it('quotes paths for sh', () => {
    assert.equal(shellQuote("/a b/it's"), `'/a b/it'\\''s'`);
    assert.equal(tap, `sh '/home/me/.claude/lookout/statusline.sh'`);
  });

  it('wraps the command and puts it back, keeping other fields', () => {
    const user = { model: 'opus', statusLine: { type: 'command', command: 'bash ~/line.sh', padding: 0 } };
    assert.deepEqual(tapStatus(user, tap), { kind: 'command', command: 'bash ~/line.sh' });
    const tapped = withTap(user, tap);
    assert.deepEqual(tapped, { model: 'opus', statusLine: { type: 'command', command: tap, padding: 0 } });
    assert.deepEqual(tapStatus(tapped, tap), { kind: 'tapped' });
    assert.deepEqual(withoutTap(tapped, 'bash ~/line.sh'), user);
    assert.deepEqual(withoutTap(withTap({ model: 'opus' }, tap), undefined), { model: 'opus' });
    assert.deepEqual(tapStatus({}, tap), { kind: 'none' });
    assert.deepEqual(tapStatus({ statusLine: { type: 'other' } }, tap), { kind: 'unsupported' });
  });

  it('keeps the file’s indentation and refuses what is not an object', () => {
    assert.equal(serializeSettings({ a: 1 }, '{\n    "a": 0\n}\n'), '{\n    "a": 1\n}\n');
    assert.equal(serializeSettings({ a: 1 }, undefined), '{\n  "a": 1\n}\n');
    assert.deepEqual(parseSettings(''), {});
    assert.throws(() => parseSettings('[1]'));
  });

  it('the script keeps the input and runs the original command with it', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'statusline.sh'), TAP_SCRIPT);
    fs.writeFileSync(path.join(dir, 'statusline-command'), `printf 'got:'; cat; exit 3`);
    const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } } });
    const run = spawnSync('sh', [path.join(dir, 'statusline.sh')], { input, encoding: 'utf8' });
    assert.equal(run.stdout, `got:${input}`);
    assert.equal(run.status, 3);
    assert.equal(fs.readFileSync(path.join(dir, 'statusline.json'), 'utf8'), input);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
    fs.rmSync(path.join(dir, 'statusline-command'));
    const quiet = spawnSync('sh', [path.join(dir, 'statusline.sh')], { input: '{}', encoding: 'utf8' });
    assert.equal(quiet.stdout, '');
    assert.equal(quiet.status, 0);
  });
});

describe('setting up and removing the step', () => {
  it('wraps the user’s command, notices a change and puts everything back', () => {
    const config = tmp();
    const paths = pathsFor(config);
    const original = '{\n    "model": "opus",\n    "statusLine": {\n        "type": "command",\n        "command": "bash /x/line.sh"\n    }\n}\n';
    fs.writeFileSync(paths.settings, original, { mode: 0o640 });
    assert.equal(tapHealth(paths), 'notSetUp');
    assert.deepEqual(installTap(paths), { ok: true });
    assert.equal(tapHealth(paths), 'ok');
    const after = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
    assert.equal(after.statusLine.command, tapCommand(paths.tapScript));
    assert.equal(fs.statSync(paths.settings).mode & 0o777, 0o640);
    assert.equal(fs.readFileSync(paths.tapCommandFile, 'utf8'), 'bash /x/line.sh');
    assert.equal(fs.readFileSync(paths.settingsBackup, 'utf8'), original);
    assert.deepEqual(installTap(paths), { ok: true }, 'a second time keeps the same original');
    assert.equal(fs.readFileSync(paths.tapCommandFile, 'utf8'), 'bash /x/line.sh');

    const replaced = { ...after, statusLine: { type: 'command', command: 'ccstatusline' } };
    fs.writeFileSync(paths.settings, JSON.stringify(replaced));
    assert.equal(tapHealth(paths), 'changed');
    assert.deepEqual(installTap(paths), { ok: true });
    assert.equal(fs.readFileSync(paths.tapCommandFile, 'utf8'), 'ccstatusline');

    assert.deepEqual(removeTap(paths), { ok: true, removed: true });
    assert.equal(JSON.parse(fs.readFileSync(paths.settings, 'utf8')).statusLine.command, 'ccstatusline');
    assert.equal(tapHealth(paths), 'notSetUp');
    assert.deepEqual(removeTap(paths), { ok: true, removed: false });
  });

  it('adds a status line where there was none and removes it again, through a symlink', () => {
    const config = tmp();
    const dotfiles = tmp();
    const paths = pathsFor(config);
    fs.writeFileSync(path.join(dotfiles, 'settings.json'), '{"model":"opus"}');
    fs.symlinkSync(path.join(dotfiles, 'settings.json'), paths.settings);
    assert.deepEqual(installTap(paths), { ok: true });
    assert.equal(fs.lstatSync(paths.settings).isSymbolicLink(), true);
    assert.equal(fs.existsSync(paths.tapCommandFile) && fs.readFileSync(paths.tapCommandFile, 'utf8'), '');
    assert.deepEqual(removeTap(paths), { ok: true, removed: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dotfiles, 'settings.json'), 'utf8')), { model: 'opus' });
  });

  it('refuses a broken settings file and leaves it alone', () => {
    const paths = pathsFor(tmp());
    fs.writeFileSync(paths.settings, '{ broken');
    const result = installTap(paths);
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(paths.settings, 'utf8'), '{ broken');
  });
});

describe('paths', () => {
  it('honours CLAUDE_CONFIG_DIR', () => {
    assert.equal(claudeConfigDir({}, '/home/me'), '/home/me/.claude');
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/etc/claude' }, '/home/me'), '/etc/claude');
    assert.equal(displayPath('/home/me/.claude/settings.json', '/home/me'), '~/.claude/settings.json');
  });
});

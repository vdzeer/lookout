// Runs inside a throwaway editor instance (see dev/run-integration.sh) with
// CLAUDE_CONFIG_DIR pointing at a fake Claude Code folder. Sessions are
// backed by real `sleep` processes: one in a terminal of this window, one
// under the extension host, one outside the editor and a background job.
// A second window checks that notifications are shown once and that opening
// a folder that is already open focuses its window instead of a new one.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const OUT = process.env.TG_OUT;
const HOLD = Number(process.env.TG_HOLD_MS || 0);
const WORK = process.env.TG_WORK;
const CLAUDE = process.env.CLAUDE_CONFIG_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => fs.appendFileSync(OUT, `${line}\n`);

async function until(what, fn, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out: ${what}`);
}

function check(name, ok, detail = '') {
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
}

const children = [];
function startSleep(detached = false) {
  if (detached) {
    // `sh` exits at once and the sleep is re-parented: a session outside any editor.
    const pid = Number(cp.execSync(`sh -c 'sleep 600 >/dev/null 2>&1 & echo $!'`).toString().trim());
    children.push(pid);
    return pid;
  }
  const child = cp.spawn('sleep', ['600'], { stdio: 'ignore' });
  children.push(child.pid);
  return child.pid;
}

const procStart = (pid) =>
  cp.execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).toString().trim().replace(/\s+/g, ' ');

function writeSession(pid, fields) {
  const data = {
    pid,
    sessionId: fields.sessionId,
    cwd: WORK,
    startedAt: Date.now(),
    procStart: fields.procStart ?? procStart(pid),
    kind: fields.kind ?? 'interactive',
    entrypoint: 'cli',
    name: fields.name,
    status: fields.status,
    statusUpdatedAt: fields.since ?? Date.now(),
    updatedAt: Date.now(),
    ...(fields.waitingFor ? { waitingFor: fields.waitingFor } : {}),
  };
  fs.writeFileSync(path.join(CLAUDE, 'sessions', `${pid}.json`), JSON.stringify(data));
}

const shownLog = () => {
  try {
    return fs.readFileSync(path.join(CLAUDE, 'lookout', 'shown.log'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

function freshWindows() {
  const dir = path.join(CLAUDE, 'lookout', 'windows');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((w) => Date.now() - w.at < 20000);
}

function runTap(input) {
  return cp.spawnSync('sh', [path.join(CLAUDE, 'lookout', 'statusline.sh')], { input: JSON.stringify(input), encoding: 'utf8' });
}

const limitsInput = (five, week) => {
  const now = Math.floor(Date.now() / 1000);
  return { session_id: 'x', rate_limits: { five_hour: { used_percentage: five, resets_at: now + 3 * 3600 }, seven_day: { used_percentage: week, resets_at: now + 4 * 86400 } } };
};

async function run() {
  const api = await vscode.extensions.getExtension('vdzeer.lookout').activate();
  check('extension activates', !!api);
  if (!api) return;
  await api.refresh();
  check('no sessions at first', api.items().sessions === '$(circle-outline) No sessions', api.items().sessions);
  check('limits wait for the setup', api.items().limits === '$(dashboard) Limits: set up' && api.health() === 'notSetUp', api.items().limits);

  // Sessions in every kind of place.
  const hostPid = startSleep();
  const outPid = startSleep(true);
  const bgPid = startSleep();
  const terminal = vscode.window.createTerminal({ name: 'lookout-test', cwd: WORK });
  terminal.sendText('sleep 600');
  const shellPid = await terminal.processId;
  const termPid = await until('sleep in the terminal', () => {
    try {
      return Number(cp.execFileSync('pgrep', ['-P', String(shellPid), 'sleep']).toString().trim().split('\n')[0]) || undefined;
    } catch {
      return undefined;
    }
  });
  children.push(termPid);
  writeSession(hostPid, { sessionId: 'host', name: 'host-session', status: 'idle' });
  writeSession(outPid, { sessionId: 'out', name: 'out-session', status: 'idle' });
  writeSession(bgPid, { sessionId: 'bg', name: 'bg-job', status: 'busy', kind: 'bg' });
  writeSession(termPid, { sessionId: 'term', name: 'term-session', status: 'idle' });
  // Files that must not count: a dead process, a reused pid, the daemon.
  writeSession(process.pid, { sessionId: 'reused', name: 'reused', status: 'busy', procStart: 'Thu Jan  1 00:00:00 2026' });
  fs.writeFileSync(path.join(CLAUDE, 'sessions', '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'dead', status: 'busy' }));
  fs.writeFileSync(path.join(CLAUDE, 'sessions', '1.json'), JSON.stringify({ pid: 1, sessionId: 'daemon', kind: 'daemon' }));
  await api.refresh();
  const places = Object.fromEntries(api.sessions().map((s) => [s.sessionId, s.place]));
  check('live sessions only', api.sessions().length === 4, JSON.stringify(places));
  check('a session in this window’s terminal', places.term === 'thisTerminal');
  check('a session under this window’s extension host', places.host === 'thisHost');
  check('a session outside the editor', places.out === 'outside');
  check('a background job', places.bg === 'background');
  check('one working, three idle', /^\$\(loading~spin\) bg-job · \d+s$/.test(api.items().sessions), api.items().sessions);

  writeSession(hostPid, { sessionId: 'host', name: 'host-session', status: 'busy', since: Date.now() - 70_000 });
  await api.refresh();
  check('two working, the longest run shown', /^\$\(loading~spin\) 2 working · 1m 1\ds$/.test(api.items().sessions), api.items().sessions);

  writeSession(termPid, { sessionId: 'term', name: 'term-session', status: 'waiting', waitingFor: 'input needed' });
  await api.refresh();
  check('a waiting session comes first, in warning colour', api.items().sessions === '$(bell-dot) term-session needs you · 2 working' && api.items().sessionsWarning, api.items().sessions);
  await until('needs-you notification', () => api.shown().some((k) => k.startsWith('needsYou:term:')), 5000).catch(() => undefined);
  check('a notification says it needs you', api.shown().some((k) => k.startsWith('needsYou:term:')), api.shown().join(','));

  writeSession(hostPid, { sessionId: 'host', name: 'host-session', status: 'idle', since: Date.now() });
  await api.refresh();
  await until('finished notification', () => api.shown().some((k) => k.startsWith('finished:host:')), 5000).catch(() => undefined);
  check('a notification says a long turn finished', api.shown().some((k) => k.startsWith('finished:host:')), api.shown().join(','));

  const tooltip = api.tooltip();
  check('the tooltip groups the sessions', ['This window', 'Outside the editor', 'Background'].every((g) => tooltip.includes(g)), tooltip.slice(0, 200));

  // Usage limits through the status line step.
  await api.setUpLimits();
  const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'));
  check('setup wraps the status line', api.health() === 'ok' && settings.statusLine.command.includes('lookout/statusline.sh') && settings.model === 'opus');
  const tapped = runTap(limitsInput(34.4, 41));
  check('the user’s own status line still prints', tapped.stdout === 'mine' && tapped.status === 0, JSON.stringify(tapped.stdout));
  await api.refresh();
  check('limits show', api.items().limits === '$(dashboard) 5h 34% · wk 41%', api.items().limits);
  runTap(limitsInput(96, 41));
  await api.refresh();
  check('a limit at 95% turns red', api.items().limits.startsWith('$(dashboard) 5h 96% · resets') && api.items().limitsBackground === 'statusBarItem.errorBackground', `${api.items().limits} ${api.items().limitsBackground}`);
  if (HOLD) {
    // For a look at the real status bar: everything is on screen now.
    writeSession(termPid, { sessionId: 'term', name: 'term-session', status: 'waiting', waitingFor: 'input needed' });
    log(`HOLD ${HOLD}`);
    await sleep(HOLD);
  }
  await until('limit notification', () => api.shown().some((k) => k.startsWith('limitNear:fiveHour:95')), 5000).catch(() => undefined);
  check('a notification says the limit is close', api.shown().some((k) => k.startsWith('limitNear:fiveHour:95')), api.shown().join(','));

  // A second window.
  const workspace2 = vscode.Uri.file(path.join(WORK, 'workspace2'));
  await vscode.commands.executeCommand('vscode.openFolder', workspace2, { forceNewWindow: true });
  const second = await until('second window', () => api.windows().find((w) => w.name === 'workspace2'), 30000).catch(() => undefined);
  check('a second window announces itself', !!second, JSON.stringify(api.windows()));
  if (second) {
    const dupPid = startSleep(true);
    writeSession(dupPid, { sessionId: 'dup', name: 'dup-session', status: 'idle' });
    await sleep(3000);
    writeSession(dupPid, { sessionId: 'dup', name: 'dup-session', status: 'waiting', waitingFor: 'input needed' });
    await sleep(5000);
    const lines = shownLog().filter((l) => l.includes('needsYou:dup:'));
    check('with two windows the notification shows once', lines.length === 1, lines.join(' | '));

    const before = freshWindows().length;
    await vscode.commands.executeCommand('vscode.openFolder', workspace2, { forceNewWindow: true });
    await sleep(8000);
    check('opening a folder that is open focuses its window, no new one', freshWindows().length === before, `${before} -> ${freshWindows().length}`);

    const request = path.join(CLAUDE, 'lookout', 'requests', `${second.pid}-test.json`);
    fs.writeFileSync(request, JSON.stringify({ sessionId: 'nothing', at: Date.now() }));
    await until('request taken', () => !fs.existsSync(request), 8000).catch(() => undefined);
    check('the other window takes a "show this session" request', !fs.existsSync(request));
  }

  // Removing the step puts the user's command back.
  await api.removeLimits();
  const restored = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'));
  check('remove puts the status line back', restored.statusLine.command === 'printf mine' && api.health() === 'notSetUp', restored.statusLine.command);

  for (const pid of children) fs.rmSync(path.join(CLAUDE, 'sessions', `${pid}.json`), { force: true });
  terminal.dispose();
  await api.refresh();
  check('ended sessions disappear', api.sessions().length === 0, JSON.stringify(api.sessions()));
}

const DONE = () => path.join(WORK, 'done');

exports.run = async () => {
  // Every window of the test instance runs this file. Only the first window
  // tests; the second one stays open until the first is done.
  if (vscode.workspace.name !== 'workspace') {
    await until('first window done', () => fs.existsSync(DONE()), 240000).catch(() => undefined);
    return;
  }
  try {
    await run();
  } catch (error) {
    log(`FAIL exception: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(DONE(), '');
    for (const pid of children) {
      try {
        process.kill(pid);
      } catch {
        // Gone already.
      }
    }
  }
};

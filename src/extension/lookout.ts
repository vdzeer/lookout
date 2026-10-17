import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { claim, pruneClaims } from '../core/claims';
import { detectEvents, observe, type LookoutEvent, type NotifySettings, type Observation } from '../core/events';
import { bar, formatClock, formatDuration } from '../core/format';
import { t } from '../core/i18n';
import { cleanThresholds, effective, parseStatusLineInput, type Limits } from '../core/limits';
import { claudeConfigDir, displayPath, pathsFor, type Paths } from '../core/paths';
import { isThisWindow, placeOf, type Session } from '../core/places';
import { isSameProcess, readProcesses, type ProcessTable } from '../core/processes';
import { isSessionFileName, parseSessionFile, type SessionFile } from '../core/sessions';
import { installTap, readTapInput, removeTap, tapHealth, type SetupResult, type TapHealth } from '../core/setupFiles';
import { groupSessions, limitsText, placeLabel, sessionsText, stateIcon, stateLabel, tooltipMarkdown, type ViewInput } from '../core/view';
import { isFresh, readWindowRecords, writeFileAtomic, writeWindowRecord, type WindowRecord } from '../core/windows';

/** Durations in the status bar move every second. */
const TICK_MS = 1000;
/** File watching is fast but not guaranteed everywhere; this catches what it misses. */
const REFRESH_MS = 2000;
/** `ps` again at least this often, so a reused pid is noticed. */
const PROCESS_TABLE_MS = 10_000;
const HEARTBEAT_MS = 5000;
const MUTE_MS = 60 * 60 * 1000;
const REQUEST_TTL_MS = 30_000;
const CLAIM_TTL_MS = 2 * 24 * 60 * 60 * 1000;
/** Who shows a notification: the window in front at once, the session's own window next, then any. */
const NOTIFY_DELAY_MS = { focused: 0, anotherFocused: 1500, owner: 300, other: 900 };
const SETUP_ASK_DELAY_MS = 4000;

const LINK_COMMANDS = ['lookout.reveal', 'lookout.showSessions', 'lookout.mute', 'lookout.unmute', 'lookout.setUpLimits', 'workbench.action.openSettings'];

interface Config {
  scope: 'all' | 'window';
  showWeekly: boolean;
  thresholds: number[];
  notify: NotifySettings;
  system: 'whenUnfocused' | 'always' | 'never';
}

function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('lookout');
  const thresholds = cleanThresholds(c.get<unknown[]>('limits.thresholds', [80, 95]));
  return {
    scope: c.get<string>('scope') === 'window' ? 'window' : 'all',
    showWeekly: c.get<boolean>('limits.showWeekly', true),
    thresholds,
    notify: {
      needsYou: c.get<boolean>('notifications.needsYou', true),
      finished: c.get<boolean>('notifications.finished', true),
      finishedAfterMs: Math.max(0, c.get<number>('notifications.finishedAfterSeconds', 60)) * 1000,
      limitNear: c.get<boolean>('notifications.limitNear', true),
      limitReset: c.get<boolean>('notifications.limitReset', true),
      thresholds,
    },
    system: (['always', 'never'] as const).find((v) => v === c.get<string>('notifications.system')) ?? 'whenUnfocused',
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const appleString = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export class Lookout implements vscode.Disposable {
  private readonly paths: Paths = pathsFor(claudeConfigDir());
  private readonly sessionsItem: vscode.StatusBarItem;
  private readonly limitsItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly watchers: fs.FSWatcher[] = [];
  /** This window's terminals by shell pid. */
  private readonly shells = new Map<number, vscode.Terminal>();
  private config = readConfig();
  /** Every live session on the computer, placed from this window's point of view. */
  private all: Session[] = [];
  private unsupported = false;
  private limits: Limits | undefined;
  private limitsMtime = 0;
  private health: TapHealth = 'notSetUp';
  private table: ProcessTable = new Map();
  private tableAt = 0;
  private others: WindowRecord[] = [];
  private mutedUntil: number | undefined;
  private observation: Observation | undefined;
  private refreshing = false;
  private refreshAgain = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  private lastTooltip = '';
  private askedSetUp = false;
  /** Notifications shown by this window, for the integration run. */
  private readonly shown: string[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.sessionsItem = vscode.window.createStatusBarItem('lookout.sessions', vscode.StatusBarAlignment.Right, 101);
    this.sessionsItem.name = 'Lookout: Claude Code Sessions';
    this.sessionsItem.command = 'lookout.showSessions';
    this.limitsItem = vscode.window.createStatusBarItem('lookout.limits', vscode.StatusBarAlignment.Right, 100);
    this.limitsItem.name = 'Lookout: Usage Limits';
    this.disposables.push(this.sessionsItem, this.limitsItem);

    if (process.platform === 'win32') {
      this.sessionsItem.text = '$(circle-slash) Lookout';
      this.sessionsItem.tooltip = t('notSupported');
      this.sessionsItem.command = undefined;
      this.sessionsItem.show();
      return;
    }

    this.registerCommands();
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => this.trackTerminal(terminal)),
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const [pid, known] of this.shells) if (known === terminal) this.shells.delete(pid);
        this.heartbeat();
        this.scheduleRefresh();
      }),
      vscode.window.onDidChangeWindowState(() => this.heartbeat()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.heartbeat()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('lookout')) return;
        this.config = readConfig();
        this.scheduleRefresh();
      }),
    );
    for (const terminal of vscode.window.terminals) this.trackTerminal(terminal);

    pruneClaims(this.paths.claims, CLAIM_TTL_MS);
    pruneClaims(this.paths.requests, REQUEST_TTL_MS * 2);
    // Records of windows that closed without saying so (a crash, a killed editor).
    pruneClaims(this.paths.windows, CLAIM_TTL_MS / 2);
    this.health = tapHealth(this.paths);
    this.watch();
    this.timers.push(
      setInterval(() => this.render(), TICK_MS),
      setInterval(() => void this.refresh(), REFRESH_MS),
      setInterval(() => this.heartbeat(), HEARTBEAT_MS),
    );
    this.heartbeat();
    this.render();
    this.sessionsItem.show();
    this.limitsItem.show();
    void this.refresh();
    setTimeout(() => void this.checkSetUp(), SETUP_ASK_DELAY_MS);
  }

  // ---- watching ----

  private watch(): void {
    const tryWatch = (target: string, onChange: (file: string | null) => void) => {
      try {
        this.watchers.push(fs.watch(target, (_event, file) => onChange(file)));
      } catch {
        // Not there yet: the regular refresh covers it.
      }
    };
    tryWatch(this.paths.sessions, () => this.scheduleRefresh());
    fs.mkdirSync(this.paths.requests, { recursive: true, mode: 0o700 });
    tryWatch(this.paths.lookout, (file) => {
      if (file === 'statusline.json' || file === 'mute.json') this.scheduleRefresh();
    });
    tryWatch(this.paths.requests, () => this.handleRequests());
    // settings.json is often replaced rather than written in place: poll it.
    const onSettings = () => {
      const health = tapHealth(this.paths);
      if (health === this.health) return;
      this.health = health;
      this.render();
      void this.checkSetUp();
    };
    fs.watchFile(this.paths.settings, { interval: 3000 }, onSettings);
    this.disposables.push({ dispose: () => fs.unwatchFile(this.paths.settings, onSettings) });
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 120);
  }

  private trackTerminal(terminal: vscode.Terminal): void {
    void terminal.processId.then((pid) => {
      if (!pid || !vscode.window.terminals.includes(terminal)) return;
      this.shells.set(pid, terminal);
      this.heartbeat();
      this.scheduleRefresh();
    });
  }

  // ---- reading ----

  private readSessionFiles(): { files: SessionFile[]; unsupported: boolean } {
    let names: string[];
    try {
      names = fs.readdirSync(this.paths.sessions).filter(isSessionFileName);
    } catch {
      return { files: [], unsupported: false };
    }
    const files: SessionFile[] = [];
    let unreadable = 0;
    for (const name of names) {
      let content: string;
      try {
        content = fs.readFileSync(path.join(this.paths.sessions, name), 'utf8');
      } catch {
        continue;
      }
      const parsed = parseSessionFile(name, content);
      if (parsed === 'daemon') continue;
      if (parsed === undefined) unreadable++;
      else files.push(parsed);
    }
    const unsupported = (unreadable > 0 && files.length === 0) || (files.length > 0 && files.every((f) => f.state === 'unknown'));
    return { files, unsupported };
  }

  private readLimits(): void {
    if (this.health !== 'ok') return;
    const input = readTapInput(this.paths);
    if (!input || input.mtimeMs === this.limitsMtime) return;
    this.limitsMtime = input.mtimeMs;
    // A session on an API key reports no limits; the last known ones still hold.
    this.limits = parseStatusLineInput(input.content, input.mtimeMs) ?? this.limits;
  }

  private readMute(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.paths.mute, 'utf8')) as { until?: unknown };
      this.mutedUntil = typeof data.until === 'number' && data.until > Date.now() ? data.until : undefined;
    } catch {
      this.mutedUntil = undefined;
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      const { files, unsupported } = this.readSessionFiles();
      // Files of crashed sessions stay behind; only a live pid the table misses calls for a new `ps`.
      if (files.some((f) => pidAlive(f.pid) && !this.table.has(f.pid)) || Date.now() - this.tableAt > PROCESS_TABLE_MS) {
        try {
          this.table = await readProcesses();
          this.tableAt = Date.now();
        } catch {
          // `ps` failed: keep the last table and try again next time.
        }
      }
      const now = Date.now();
      const live = files.filter((f) => pidAlive(f.pid) && isSameProcess(this.table, f.pid, f.procStart));
      this.others = readWindowRecords(this.paths.windows).filter((w) => w.pid !== process.pid && isFresh(w, now) && pidAlive(w.pid));
      const here = { hostPid: process.pid, shells: new Map([...this.shells].map(([pid, terminal]) => [pid, terminal.name])) };
      this.all = live.map((f) => ({ ...f, place: placeOf(f, this.table, here, this.others) }));
      this.unsupported = unsupported;
      this.readLimits();
      this.readMute();

      const next = observe(this.visible(), this.limits, now);
      const events = detectEvents(this.observation, next, this.config.notify);
      this.observation = next;
      this.render(true);
      for (const event of events) void this.deliver(event);
      this.handleRequests();
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }

  /** The sessions the status bar is about. */
  private visible(): Session[] {
    return this.config.scope === 'window' ? this.all.filter((s) => isThisWindow(s.place)) : this.all;
  }

  // ---- status bar ----

  private viewInput(): ViewInput {
    return {
      sessions: this.visible(),
      limits: this.health === 'ok' ? this.limits : undefined,
      limitsSetUp: this.health === 'ok',
      thresholds: this.config.thresholds,
      showWeekly: this.config.showWeekly,
      gridInstalled: vscode.extensions.getExtension('vdzeer.terminal-grid') !== undefined,
      unsupported: this.unsupported,
      mutedUntil: this.mutedUntil,
      now: Date.now(),
      locale: vscode.env.language,
      t,
    };
  }

  /** Texts every second; the tooltip only on a refresh, so an open hover does not flicker. */
  private render(withTooltip = false): void {
    const input = this.viewInput();
    const sessions = sessionsText(input);
    this.sessionsItem.text = sessions.text;
    this.sessionsItem.backgroundColor = sessions.level === 'waiting' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.sessionsItem.color = sessions.level === 'none' || sessions.level === 'idle' ? new vscode.ThemeColor('disabledForeground') : undefined;
    const limits = limitsText(input);
    this.limitsItem.text = limits.text;
    this.limitsItem.command = input.limitsSetUp ? 'lookout.showLimits' : 'lookout.setUpLimits';
    this.limitsItem.backgroundColor =
      limits.level === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : limits.level === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.limitsItem.color = limits.level === 'unknown' ? new vscode.ThemeColor('disabledForeground') : undefined;
    if (!withTooltip && this.lastTooltip) return;
    const markdown = tooltipMarkdown(input);
    if (markdown === this.lastTooltip) return;
    this.lastTooltip = markdown;
    const tooltip = new vscode.MarkdownString(markdown, true);
    tooltip.isTrusted = { enabledCommands: LINK_COMMANDS };
    this.sessionsItem.tooltip = tooltip;
    this.limitsItem.tooltip = tooltip;
  }

  // ---- windows ----

  private heartbeat(): void {
    if (process.platform === 'win32') return;
    const files = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    const workspaceFile = vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : undefined;
    try {
      writeWindowRecord(this.paths.windows, {
        pid: process.pid,
        app: vscode.env.appName,
        name: vscode.workspace.name ?? '',
        folders: files,
        workspaceFile,
        focused: vscode.window.state.focused,
        shells: [...this.shells.keys()],
        at: Date.now(),
      });
    } catch {
      // Claude Code's folder is read-only or missing: windows simply do not see each other.
    }
  }

  /** Another window asked this one to show a session that runs here. */
  private handleRequests(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.paths.requests).filter((name) => name.startsWith(`${process.pid}-`));
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(this.paths.requests, name);
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
        fs.unlinkSync(file);
      } catch {
        continue;
      }
      try {
        const request = JSON.parse(content) as { sessionId?: unknown; at?: unknown };
        if (typeof request.sessionId === 'string' && typeof request.at === 'number' && Date.now() - request.at < REQUEST_TTL_MS) {
          void this.reveal(request.sessionId, false);
        }
      } catch {
        // Not a request of ours.
      }
    }
  }

  // ---- going to a session ----

  async reveal(sessionId: string, fromHere = true): Promise<void> {
    const session = this.all.find((s) => s.sessionId === sessionId);
    if (!session) {
      if (fromHere) void vscode.window.showInformationMessage(t('revealGone'));
      return;
    }
    const place = session.place;
    switch (place.kind) {
      case 'thisTerminal':
        this.shells.get(place.shell)?.show(false);
        return;
      case 'thisHost': {
        const commands = await vscode.commands.getCommands(true);
        if (place.panel && commands.includes('claude-vscode.primaryEditor.open')) {
          await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', session.sessionId);
        } else if (commands.includes('terminalGrid.revealProcess')) {
          await vscode.commands.executeCommand('terminalGrid.revealProcess', session.pid);
        } else if (commands.includes('terminalGrid.open')) {
          await vscode.commands.executeCommand('terminalGrid.open');
        }
        return;
      }
      case 'otherWindow': {
        if (!fromHere) return;
        const window = place.window;
        try {
          writeFileAtomic(path.join(this.paths.requests, `${window.pid}-${Date.now()}.json`), JSON.stringify({ sessionId, at: Date.now() }));
        } catch {
          // The window can still be brought forward.
        }
        const target = window.workspaceFile ?? window.folders[0];
        if (!target) {
          void vscode.window.showInformationMessage(t('revealOtherNoFolder', session.name));
          return;
        }
        // The editor focuses the window that already has this folder open.
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
        return;
      }
      case 'outside':
        if (process.platform === 'darwin' && place.app?.bundle) {
          execFile('open', ['-a', place.app.bundle], () => undefined);
        } else if (fromHere) {
          void vscode.window.showInformationMessage(place.app ? t('revealOutside', session.name, place.app.name) : t('revealOutsideUnknown', session.name));
        }
        return;
      case 'background':
        if (fromHere) void vscode.window.showInformationMessage(t('revealNoTerminal', session.name));
        return;
    }
  }

  private async showSessions(): Promise<void> {
    await this.refresh();
    const input = this.viewInput();
    type Item = vscode.QuickPickItem & { sessionId?: string };
    const items: Item[] = [];
    for (const group of groupSessions(input.sessions, t)) {
      items.push({ label: group.title, kind: vscode.QuickPickItemKind.Separator });
      for (const session of group.sessions) {
        const where = placeLabel(session.place, input);
        const state = stateLabel(session, input);
        items.push({ label: `${stateIcon(session)} ${session.name}`, description: where ? `${state} · ${where}` : state, sessionId: session.sessionId });
      }
    }
    if (items.length === 0) {
      void vscode.window.showInformationMessage(t('noSessions'));
      return;
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: t('pickPlaceholder'), matchOnDescription: true });
    if (picked?.sessionId) await this.reveal(picked.sessionId);
  }

  private async showLimits(): Promise<void> {
    const input = this.viewInput();
    const now = Date.now();
    const items: (vscode.QuickPickItem & { action?: () => unknown })[] = [];
    for (const [name, window] of [
      [t('limitFiveHour'), input.limits?.fiveHour],
      [t('limitWeekly'), input.limits?.weekly],
    ] as const) {
      if (!window) continue;
      const e = effective(window, now);
      const clock = formatClock(e.resetsAt, now, input.locale);
      items.push({
        label: e.isReset ? t('limitLineReset', name, clock) : t('limitLine', name, Math.round(e.usedPercent), clock),
        description: e.isReset ? undefined : bar(e.usedPercent),
      });
    }
    if (items.length === 0) items.push({ label: t('limitsNoData') });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: t('linkSettings'), action: () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vdzeer.lookout') });
    items.push({ label: t('linkRemoveLimits'), action: () => this.removeLimits() });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: t('limitsTitle') });
    await picked?.action?.();
  }

  // ---- notifications ----

  private async deliver(event: LookoutEvent): Promise<void> {
    if (this.mutedUntil !== undefined && this.mutedUntil > Date.now()) return;
    const focusedHere = vscode.window.state.focused;
    const anotherFocused = this.others.some((w) => w.focused);
    const owner = (event.kind === 'needsYou' || event.kind === 'finished') && isThisWindow(event.session.place);
    const delay = focusedHere
      ? NOTIFY_DELAY_MS.focused
      : anotherFocused
        ? NOTIFY_DELAY_MS.anotherFocused
        : owner
          ? NOTIFY_DELAY_MS.owner
          : NOTIFY_DELAY_MS.other;
    if (delay) await sleep(delay);
    if (!claim(this.paths.claims, event.key)) return;
    this.shown.push(event.key);
    if (this.context.extensionMode !== vscode.ExtensionMode.Production) {
      // The integration run checks that each event was shown by exactly one window.
      fs.appendFileSync(path.join(this.paths.lookout, 'shown.log'), `${process.pid} ${event.key}\n`);
    }

    const message = this.messageFor(event);
    const noneFocused = !vscode.window.state.focused && !this.others.some((w) => w.focused);
    if (process.platform === 'darwin' && (this.config.system === 'always' || (this.config.system === 'whenUnfocused' && noneFocused))) {
      execFile('osascript', ['-e', `display notification ${appleString(message)} with title "Lookout"`], () => undefined);
    }
    const actions = event.kind === 'needsYou' ? [t('show'), t('muteHour')] : event.kind === 'finished' ? [t('show')] : [];
    const show = event.kind === 'needsYou' || event.kind === 'limitNear' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const choice = await show(message, ...actions);
    if (choice === t('show') && (event.kind === 'needsYou' || event.kind === 'finished')) await this.reveal(event.session.sessionId);
    if (choice === t('muteHour')) this.mute();
  }

  private messageFor(event: LookoutEvent): string {
    const now = Date.now();
    switch (event.kind) {
      case 'needsYou': {
        const { session } = event;
        const base = session.waitingFor ? t('notifyNeedsYou', session.name, session.waitingFor) : t('notifyNeedsYouPlain', session.name);
        return session.place.kind === 'otherWindow' ? t('notifyInWindow', base, session.place.window.name) : base;
      }
      case 'finished':
        return t('notifyFinished', event.session.name, formatDuration(event.durationMs, t));
      case 'limitNear':
        return t(
          'notifyLimitNear',
          t(event.limit === 'fiveHour' ? 'limitFiveHour' : 'limitWeekly'),
          Math.round(event.usedPercent),
          formatClock(event.resetsAt, now, vscode.env.language),
        );
      case 'limitReset':
        return t('notifyLimitReset', t(event.limit === 'fiveHour' ? 'limitFiveHour' : 'limitWeekly'));
    }
  }

  private mute(): void {
    const until = Date.now() + MUTE_MS;
    try {
      writeFileAtomic(this.paths.mute, JSON.stringify({ until }));
    } catch {
      // Muting still holds in this window.
    }
    this.mutedUntil = until;
    this.render(true);
    void vscode.window.showInformationMessage(t('muted', formatClock(until, Date.now(), vscode.env.language)));
  }

  private unmute(): void {
    fs.rmSync(this.paths.mute, { force: true });
    this.mutedUntil = undefined;
    this.render(true);
    void vscode.window.showInformationMessage(t('unmuted'));
  }

  // ---- usage limits setup ----

  /** Asks about the status line step when it is not set up yet, or when the user's status line replaced it. */
  private async checkSetUp(): Promise<void> {
    this.health = tapHealth(this.paths);
    this.render(true);
    if (this.health === 'ok') return;
    if (this.health === 'changed') {
      if (!claim(this.paths.claims, `changed:${this.settingsStamp()}`)) return;
      const choice = await vscode.window.showInformationMessage(t('askChanged'), t('keepShowing'), t('stop'));
      if (choice === t('keepShowing')) this.report(installTap(this.paths), false);
      else if (choice === t('stop')) removeTap(this.paths);
      this.health = tapHealth(this.paths);
      this.render(true);
      return;
    }
    if (this.askedSetUp || this.context.globalState.get<string>('lookout.setUpAnswer') === 'never') return;
    this.askedSetUp = true;
    // One window asks, once a day at most.
    if (!claim(this.paths.claims, `askSetUp:${new Date().toDateString()}`)) return;
    const choice = await vscode.window.showInformationMessage(t('askSetUp', displayPath(this.paths.settings)), t('setUp'), t('notNow'), t('never'));
    if (choice === t('setUp')) await this.setUpLimits();
    else if (choice === t('never')) await this.context.globalState.update('lookout.setUpAnswer', 'never');
  }

  private settingsStamp(): number {
    try {
      return fs.statSync(this.paths.settings).mtimeMs;
    } catch {
      return 0;
    }
  }

  private async setUpLimits(): Promise<void> {
    if (tapHealth(this.paths) === 'ok') {
      void vscode.window.showInformationMessage(t('setUpAlready'));
      return;
    }
    this.report(installTap(this.paths), true);
    this.health = tapHealth(this.paths);
    this.render(true);
  }

  private report(result: SetupResult, announce: boolean): void {
    const file = displayPath(this.paths.settings);
    if (result.ok) {
      if (announce) void vscode.window.showInformationMessage(t('setUpDone'));
    } else if (result.reason === 'unsupported') void vscode.window.showWarningMessage(t('setUpUnsupported', file));
    else if (result.reason === 'unreadable') void vscode.window.showErrorMessage(t('settingsUnreadable', file, result.detail));
    else void vscode.window.showErrorMessage(t('settingsUnwritable', file, result.detail));
  }

  private removeLimits(): void {
    const result = removeTap(this.paths);
    const file = displayPath(this.paths.settings);
    if (!result.ok) {
      void vscode.window.showErrorMessage(t(result.reason === 'unreadable' ? 'settingsUnreadable' : 'settingsUnwritable', file, result.detail));
      return;
    }
    void vscode.window.showInformationMessage(result.removed ? t('removed') : t('removeNothing'));
    this.limits = undefined;
    this.limitsMtime = 0;
    this.health = tapHealth(this.paths);
    this.render(true);
  }

  // ---- commands ----

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('lookout.showSessions', () => this.showSessions()),
      vscode.commands.registerCommand('lookout.showLimits', () => this.showLimits()),
      vscode.commands.registerCommand('lookout.setUpLimits', () => this.setUpLimits()),
      vscode.commands.registerCommand('lookout.removeLimits', () => this.removeLimits()),
      vscode.commands.registerCommand('lookout.mute', () => this.mute()),
      vscode.commands.registerCommand('lookout.unmute', () => this.unmute()),
      vscode.commands.registerCommand('lookout.reveal', (sessionId: unknown) => {
        if (typeof sessionId === 'string') return this.reveal(sessionId);
      }),
    );
  }

  /** Read-only view for the integration run; only returned outside production. */
  testApi() {
    return {
      refresh: () => this.refresh(),
      sessions: () => this.all.map((s) => ({ sessionId: s.sessionId, name: s.name, state: s.state, place: s.place.kind })),
      items: () => ({
        sessions: this.sessionsItem.text,
        limits: this.limitsItem.text,
        sessionsWarning: this.sessionsItem.backgroundColor !== undefined,
        limitsBackground: (this.limitsItem.backgroundColor as { id?: string } | undefined)?.id,
      }),
      tooltip: () => this.lastTooltip,
      shown: () => [...this.shown],
      health: () => this.health,
      reveal: (sessionId: string) => this.reveal(sessionId),
      setUpLimits: () => this.setUpLimits(),
      removeLimits: () => this.removeLimits(),
      windows: () => this.others.map((w) => ({ pid: w.pid, name: w.name, focused: w.focused })),
      paths: this.paths,
    };
  }

  dispose(): void {
    for (const timer of this.timers) clearInterval(timer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const watcher of this.watchers) watcher.close();
    for (const disposable of this.disposables) disposable.dispose();
    fs.rmSync(path.join(this.paths.windows, `${process.pid}.json`), { force: true });
  }
}

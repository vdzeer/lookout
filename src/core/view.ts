import { bar, formatAge, formatClock, formatDuration } from './format';
import type { Translate } from './i18n';
import { effective, levelOf, type LimitLevel, type Limits, type LimitWindow } from './limits';
import { isThisWindow, type Place, type Session } from './places';

// What the two status bar items and their tooltips say. Pure: the extension
// turns the result into status bar items and a Markdown tooltip.

export interface ViewInput {
  sessions: readonly Session[];
  limits: Limits | undefined;
  limitsSetUp: boolean;
  thresholds: readonly number[];
  showWeekly: boolean;
  gridInstalled: boolean;
  /** Session files exist but none could be read: Claude Code changed their format. */
  unsupported: boolean;
  mutedUntil: number | undefined;
  now: number;
  locale: string;
  t: Translate;
}

export type SessionsLevel = 'none' | 'idle' | 'working' | 'waiting';

const STATE_ORDER = { waiting: 0, working: 1, idle: 2, unknown: 3 } as const;

export const stateIcon = (session: Session) =>
  session.state === 'working' ? '$(loading~spin)' : session.state === 'waiting' ? '$(bell-dot)' : session.state === 'idle' ? '$(circle-outline)' : '$(question)';

export function sortSessions(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.since - b.since || a.name.localeCompare(b.name));
}

export function sessionsText(input: ViewInput): { text: string; level: SessionsLevel } {
  const { t, now } = input;
  const waiting = input.sessions.filter((s) => s.state === 'waiting');
  const working = input.sessions.filter((s) => s.state === 'working');
  if (waiting.length > 0) {
    const first = sortSessions(waiting)[0];
    const head = waiting.length === 1 && first ? t('needsYouOne', first.name) : t('needsYouMany', waiting.length);
    const tail = working.length > 0 ? ` · ${t('workingMany', working.length)}` : '';
    return { text: `$(bell-dot) ${head}${tail}`, level: 'waiting' };
  }
  if (working.length > 0) {
    const longest = Math.max(...working.map((s) => now - s.since));
    const only = working.length === 1 ? working[0] : undefined;
    const head = only ? only.name : t('workingMany', working.length);
    return { text: `$(loading~spin) ${head} · ${formatDuration(longest, t)}`, level: 'working' };
  }
  if (input.sessions.length > 0) return { text: `$(circle-outline) ${t('idleCount', input.sessions.length)}`, level: 'idle' };
  return { text: `$(circle-outline) ${t('sessionsNone')}`, level: 'none' };
}

interface WindowView {
  name: 'fiveHour' | 'weekly';
  usedPercent: number;
  resetsAt: number;
  isReset: boolean;
  level: LimitLevel;
}

function limitViews(input: ViewInput): WindowView[] {
  const limits = input.limits;
  if (!limits) return [];
  const views: WindowView[] = [];
  const add = (name: WindowView['name'], window: LimitWindow | undefined) => {
    if (!window) return;
    const e = effective(window, input.now);
    views.push({ name, ...e, level: levelOf(e.usedPercent, input.thresholds) });
  };
  add('fiveHour', limits.fiveHour);
  if (input.showWeekly) add('weekly', limits.weekly);
  return views;
}

const LEVELS: LimitLevel[] = ['normal', 'warning', 'error'];

export function limitsText(input: ViewInput): { text: string; level: LimitLevel | 'unknown' } {
  const { t } = input;
  if (!input.limitsSetUp) return { text: `$(dashboard) ${t('limitsSetUpShort')}`, level: 'unknown' };
  const views = limitViews(input);
  if (views.length === 0) return { text: `$(dashboard) ${t('limitsWaitingShort')}`, level: 'unknown' };
  const short = (v: WindowView) => t(v.name === 'fiveHour' ? 'limitFiveHourShort' : 'limitWeeklyShort', Math.round(v.usedPercent));
  const level = views.reduce<LimitLevel>((worst, v) => (LEVELS.indexOf(v.level) > LEVELS.indexOf(worst) ? v.level : worst), 'normal');
  const atError = views.find((v) => v.level === 'error');
  if (atError) {
    const clock = formatClock(atError.resetsAt, input.now, input.locale);
    return { text: `$(dashboard) ${short(atError)} · ${t('limitResetsShort', clock)}`, level };
  }
  return { text: `$(dashboard) ${views.map(short).join(' · ')}`, level };
}

/** Text in Markdown: names come from folders and Claude Code, so nothing in them may become a link or markup. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~$]/g, (c) => `\\${c}`);
}

export function placeLabel(place: Place, input: Pick<ViewInput, 't' | 'gridInstalled'>): string {
  const { t } = input;
  switch (place.kind) {
    case 'thisTerminal':
      return t('placeTerminal', place.terminalName);
    case 'thisHost':
      return place.panel ? t('placePanel') : input.gridInstalled ? t('placeGrid') : t('placeExtension');
    case 'otherWindow':
      return place.window.name;
    case 'outside':
      return place.app?.name ?? '';
    case 'background':
      return '';
  }
}

export function stateLabel(session: Session, input: Pick<ViewInput, 't' | 'now'>): string {
  const { t, now } = input;
  switch (session.state) {
    case 'working':
      return t('stateWorking', formatDuration(now - session.since, t));
    case 'waiting':
      return session.waitingFor ? t('stateNeedsYou', session.waitingFor) : t('stateNeedsYouPlain');
    case 'idle':
      return t('stateIdle', formatAge(now - session.since, t));
    case 'unknown':
      return t('stateUnknown');
  }
}

export interface Group {
  title: string;
  sessions: Session[];
}

/** This window, then other windows by name, then outside the editor, then background jobs. */
export function groupSessions(sessions: readonly Session[], t: Translate): Group[] {
  const here: Session[] = [];
  const others = new Map<string, Session[]>();
  const outside: Session[] = [];
  const background: Session[] = [];
  for (const session of sessions) {
    const place = session.place;
    if (isThisWindow(place)) here.push(session);
    else if (place.kind === 'otherWindow') {
      const key = place.window.name || String(place.window.pid);
      others.set(key, [...(others.get(key) ?? []), session]);
    } else if (place.kind === 'outside') outside.push(session);
    else background.push(session);
  }
  const groups: Group[] = [];
  if (here.length) groups.push({ title: t('groupThisWindow'), sessions: sortSessions(here) });
  for (const [name, list] of [...others].sort(([a], [b]) => a.localeCompare(b))) {
    groups.push({ title: t('groupOtherWindow', name), sessions: sortSessions(list) });
  }
  if (outside.length) groups.push({ title: t('groupOutside'), sessions: sortSessions(outside) });
  if (background.length) groups.push({ title: t('groupBackground'), sessions: sortSessions(background) });
  return groups;
}

const commandLink = (label: string, command: string, args?: unknown[]) =>
  `[${escapeMarkdown(label)}](command:${command}${args ? `?${encodeURIComponent(JSON.stringify(args))}` : ''})`;

export function tooltipMarkdown(input: ViewInput): string {
  const { t, now } = input;
  const lines: string[] = [`**${escapeMarkdown(t('tooltipTitle'))}**`, ''];
  if (input.unsupported) lines.push(escapeMarkdown(t('unsupportedFormat')), '');
  if (input.sessions.length === 0) lines.push(escapeMarkdown(t('noSessions')), '');
  for (const group of groupSessions(input.sessions, t)) {
    const rows = group.sessions.map((session) => {
      const where = placeLabel(session.place, input);
      const name = session.place.kind === 'background' ? escapeMarkdown(session.name) : commandLink(session.name, 'lookout.reveal', [session.sessionId]);
      return `${stateIcon(session)} ${name} · ${escapeMarkdown(stateLabel(session, input))}${where ? ` · _${escapeMarkdown(where)}_` : ''}`;
    });
    lines.push(`_${escapeMarkdown(group.title)}_  `, rows.join('  \n'), '');
  }

  lines.push('---', '', `**${escapeMarkdown(t('limitsTitle'))}**`, '');
  if (!input.limitsSetUp) {
    lines.push(escapeMarkdown(t('limitsNotSetUp')), '');
  } else {
    const views = limitViews(input);
    if (views.length === 0) lines.push(escapeMarkdown(t('limitsNoData')), '');
    else {
      const rows = views.map((v) => {
        const name = t(v.name === 'fiveHour' ? 'limitFiveHour' : 'limitWeekly');
        const clock = formatClock(v.resetsAt, now, input.locale);
        return v.isReset
          ? escapeMarkdown(t('limitLineReset', name, clock))
          : `${escapeMarkdown(t('limitLine', name, Math.round(v.usedPercent), clock))} \`${bar(v.usedPercent)}\``;
      });
      const age = now - (input.limits?.updatedAt ?? now);
      rows.push(`_${escapeMarkdown(age < 60_000 ? t('limitsUpdatedNow') : t('limitsUpdated', formatAge(age, t)))}_`);
      lines.push(rows.join('  \n'), '');
    }
  }

  const muted = input.mutedUntil !== undefined && input.mutedUntil > now;
  if (muted) lines.push(`_${escapeMarkdown(t('mutedUntil', formatClock(input.mutedUntil ?? now, now, input.locale)))}_`, '');
  const links = [
    commandLink(t('linkGoTo'), 'lookout.showSessions'),
    muted ? commandLink(t('linkUnmute'), 'lookout.unmute') : commandLink(t('linkMute'), 'lookout.mute'),
    ...(input.limitsSetUp ? [] : [commandLink(t('linkSetUp'), 'lookout.setUpLimits')]),
    commandLink(t('linkSettings'), 'workbench.action.openSettings', ['@ext:vdzeer.lookout']),
  ];
  lines.push('---', '', links.join(' · '));
  return lines.join('\n');
}

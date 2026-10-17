# Lookout

Claude Code sessions and usage limits in your editor's status bar. See at a
glance which sessions are working, which one waits for you, and how much of
your 5-hour and weekly limits is used, across every editor window and
terminal on your computer.

Works in VS Code 1.105 or later and the editors built on it (Antigravity,
Cursor, VSCodium, Windsurf), on macOS and Linux.

## What it shows

Two items on the right of the status bar:

- **Sessions.** One session working shows its name and how long it has been
  at it (`projects-f7 · 1m 03s`); several show a count and the longest run
  (`3 working · 6m 20s`). A session waiting for you, for a permission prompt,
  a question or another dialog, comes first and turns the item yellow
  (`skarbnyk needs you · 2 working`). With nothing running the item stays,
  dimmed (`3 idle`).
- **Limits.** The 5-hour and weekly limits (`5h 34% · wk 41%`). From 80% the
  item turns yellow, from 95% red with the time the limit resets. Both
  levels are settings.

Hover either item for every session, grouped by where it runs (this window,
other windows by folder name, outside the editor such as iTerm2 or Terminal,
and background jobs), both limits with their reset times, and links to mute
notifications or open the settings.

Click the sessions item to pick a session and go to it: its terminal in this
window, a [Terminal Grid](https://github.com/vdzeer/terminal-grid) tile, the
window it runs in (that window comes to the front), or the terminal app it
runs in.

## Notifications

- A session needs you.
- A session finished a turn that took a minute or longer.
- The 5-hour or weekly limit reaches 80% or 95%.
- A limit that reached 95% has reset.

Each one can be turned off, and the numbers changed, in the settings. With
several editor windows open, each notification shows once, in the window you
are looking at. When no editor window is in front, it also goes to macOS
Notification Center (setting `lookout.notifications.system`). Those come from
a system helper, so they carry the Script Editor icon, and clicking one opens
Script Editor; the editor's own notification has the buttons. "Mute for
1 Hour" quiets every window.

## Usage limits: one step in your status line

Claude Code hands its status line command the current usage limits. To read
them, Lookout asks once whether it may add a small step in front of your
status line command in `~/.claude/settings.json`:

- `statusLine.command` becomes `sh ~/.claude/lookout/statusline.sh`. The
  script keeps the status line input in `~/.claude/lookout/statusline.json`
  and then runs your own command with the same input, so your status line
  looks exactly as before. Without a status line of your own, nothing is
  printed, as before.
- Your command is kept in `~/.claude/lookout/statusline-command`, and a copy
  of `settings.json` from before the change in
  `~/.claude/lookout/settings.backup.json`.
- "Lookout: Remove Usage Limits" puts your command back exactly. So does
  uninstalling the extension.
- If you change your status line later (for example with `/statusline`),
  Lookout notices and asks whether to keep showing limits with the new one.

Limits are as fresh as the last reply of any Claude Code session; once a
limit's reset time passes, it shows as reset. Accounts that use an API key
have no 5-hour or weekly limits, so the item stays at "Limits: waiting". A
status line set in a
project's `.claude/settings.json` replaces the user one in that project, and
sessions there do not report limits.

## How it works

- Claude Code keeps a small file for every running session in
  `~/.claude/sessions/`, with its state (working, waiting, idle). Lookout
  reads those files and checks with `ps` that each session is still alive
  and is the same process. Nothing is installed into Claude Code for this.
  The file format is internal to Claude Code: if a release changes it, the
  tooltip says Lookout does not know the format yet, instead of showing
  wrong data.
- Where a session runs is worked out from its parent processes: the shells
  of this window's terminals, this window's extension host (Terminal Grid
  tiles), or the terminal app it was started from.
- Editor windows find each other through small files in
  `~/.claude/lookout/windows/`, and pick one window per notification with a
  file in `~/.claude/lookout/claims/`.
- Everything stays on your computer. Lookout makes no network requests.

`CLAUDE_CONFIG_DIR` is honoured in place of `~/.claude`.

## Settings

| Setting | Default | |
|---|---|---|
| `lookout.scope` | `all` | `all`: every session on this computer; `window`: only sessions in this window. |
| `lookout.limits.showWeekly` | `true` | Show the weekly limit next to the 5-hour one. |
| `lookout.limits.thresholds` | `[80, 95]` | Yellow and notification from the lowest, red from the highest. |
| `lookout.notifications.needsYou` | `true` | A session waits for you. |
| `lookout.notifications.finished` | `true` | A long turn finished. |
| `lookout.notifications.finishedAfterSeconds` | `60` | How long a turn must take to count as long. |
| `lookout.notifications.limitNear` | `true` | A limit reached a threshold. |
| `lookout.notifications.limitReset` | `true` | A limit that reached the highest threshold reset. |
| `lookout.notifications.system` | `whenUnfocused` | macOS Notification Center: `whenUnfocused`, `always` or `never`. |

## Commands

- Lookout: Go to Session…
- Lookout: Show Usage Limits
- Lookout: Set Up Usage Limits
- Lookout: Remove Usage Limits
- Lookout: Mute Notifications for 1 Hour
- Lookout: Unmute Notifications

## Limits of this version

- macOS and Linux. Windows shows a note instead.
- Sessions on a remote machine (SSH, containers, WSL) are not seen: Lookout
  runs on your computer, next to the editor window.
- In iTerm2, Terminal and other terminal apps, the app comes to the front,
  not the exact tab.

## License

[MIT](LICENSE)

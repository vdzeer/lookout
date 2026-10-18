# Changelog

## 0.1.1

- Usage limits now follow every reply. The status line step kept the input
  only after your own status line command had finished, and Claude Code
  cancels a command that is still running when the next update comes, so
  with a slower status line most updates were lost while a session worked.
  The input is now kept first. A step set up by 0.1.0 is updated when the
  extension starts, and the files cancelled runs left in
  `~/.claude/lookout/` are removed.

## 0.1.0

First release.

- Status bar items for Claude Code sessions (working, waiting for you,
  idle) and for the 5-hour and weekly usage limits.
- Tooltip with every session grouped by window, terminal app and background,
  and both limits with their reset times.
- "Go to Session…": the session's terminal, Terminal Grid tile, editor
  window or terminal app.
- Notifications when a session needs you, a long turn finishes, a limit gets
  close or resets; one per event across all editor windows, optionally also
  in macOS Notification Center.
- Usage limits through one step in front of the Claude Code status line,
  added only after you agree and removed exactly, also on uninstall.

// The editor runs this (`vscode:uninstall`) after Lookout is uninstalled:
// Claude Code's status line gets the user's own command back, so it does not
// point at a script nobody maintains any more.
import { claudeConfigDir, pathsFor } from './core/paths';
import { removeTap } from './core/setupFiles';

removeTap(pathsFor(claudeConfigDir()));

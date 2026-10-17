import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// With several editor windows open, every window sees the same session
// change. A notification is shown by whichever window first creates the
// event's claim file; creating a file that exists fails, so only one wins.

export function claim(dir: string, key: string): boolean {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, createHash('sha256').update(key).digest('hex').slice(0, 32));
  try {
    fs.writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // An unwritable folder must not silence notifications: show it here.
    return true;
  }
}

/** Claims only need to outlive the moment all windows see an event. */
export function pruneClaims(dir: string, olderThanMs: number, now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > olderThanMs) fs.unlinkSync(file);
    } catch {
      // Another window pruned it first.
    }
  }
}

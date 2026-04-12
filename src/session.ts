/**
 * session.ts — session file path + permission enforcement.
 *
 * The underlying FileSessionStore (from ticktick-client) handles the actual
 * read/write of the session blob. This module only takes responsibility for:
 *
 *   1. Resolving the session file path under the skill directory
 *   2. Creating the .session/ directory with mode 0700 if missing
 *   3. Enforcing mode 0600 on the session file when it exists
 *   4. Providing a `clearSession` helper for `logout`
 *
 * The session file contains a cookie/token blob from TickTick. It is NOT a
 * secret of the same shape as a long-lived password, but it IS a live auth
 * token for the user's account. Same hygiene as a browser session cookie.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Returns the absolute path to the session file, creating the parent
 * directory with mode 0700 if it doesn't exist, and enforcing mode 0600
 * on the file if it already exists.
 */
export function resolveSessionPath(): string {
  const skillDir = resolveSkillDir();
  const sessionDir = join(skillDir, '.session');

  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true, mode: DIR_MODE });
  } else {
    // Tighten directory perms if they drifted (e.g., manual file creation).
    try {
      chmodSync(sessionDir, DIR_MODE);
    } catch {
      // Non-fatal — if we can't chmod, we'll still try to proceed. The library
      // will fail loudly on read/write if perms actually block us.
    }
  }

  const sessionPath = join(sessionDir, 'ticktick.json');

  if (existsSync(sessionPath)) {
    try {
      const mode = statSync(sessionPath).mode & 0o777;
      if (mode !== FILE_MODE) chmodSync(sessionPath, FILE_MODE);
    } catch {
      // Same — non-fatal; library will surface the real error if perms block it.
    }
  }

  return sessionPath;
}

/**
 * Delete the session file if present. Called by `logout`.
 * Idempotent.
 */
export function clearSession(): void {
  const path = resolveSessionPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Non-fatal; the logout command reports overall success/failure.
    }
  }
}

/**
 * Seconds since the session file was last written.
 * Returns null if no session exists. Used by `whoami`.
 */
export function getSessionAgeSeconds(): number | null {
  const path = resolveSessionPath();
  if (!existsSync(path)) return null;
  try {
    const mtime = statSync(path).mtimeMs;
    return Math.floor((Date.now() - mtime) / 1000);
  } catch {
    return null;
  }
}

/**
 * Resolve the skill directory from this file's location, regardless of
 * where the Bun process was invoked from. We climb up from src/session.ts
 * to the skill root.
 */
function resolveSkillDir(): string {
  const here = fileURLToPath(import.meta.url);
  // /.../skills/TickTick/src/session.ts → /.../skills/TickTick
  return dirname(dirname(here));
}

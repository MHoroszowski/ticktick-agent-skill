/**
 * env.ts — load TickTick credentials.
 *
 * Precedence (first match wins at read time; reads cache both files):
 *   1. process.env (already set, from a parent shell or CLI wrapper)
 *   2. ~/.env — user-owned overlay (optional)
 *   3. ~/.config/athena/.env — shared XDG-compliant secrets file
 *   4. undefined → caller decides whether to fail
 *
 * The XDG file is the canonical home for shared secrets; ~/.env is
 * the user's personal file and is read as an optional overlay so users
 * can keep ~/.env for their own purposes without the shared file claiming it.
 *
 * Two accounts are supported, selected by `context.getAccount()`:
 *   - 'live' (default) — the user's personal TickTick account. Keys:
 *     TICKTICK_EMAIL (or TICKTICK_USERNAME) and TICKTICK_PASSWORD.
 *     These are user-scoped and belong in ~/.env.
 *   - 'test' — a dedicated service account for skill development.
 *     Keys: TICKTICK_TEST_EMAIL (or TICKTICK_TEST_USERNAME) and
 *     TICKTICK_TEST_PASSWORD. These are project-scoped and belong in
 *     ~/.config/athena/.env.
 *
 * This skill never reads credentials from settings.json or the skill
 * directory itself. If a secret lands in a file tracked by git or a
 * harness config, that's a bug.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAccount } from './context.ts';

export type Credentials = {
  readonly email: string;
  readonly password: string;
};

/**
 * Load credentials for the currently-active account (set via
 * `context.setAccount`). Returns null if either value is missing — the
 * caller should surface AUTH_MISSING_CREDS with an actionable hint.
 */
export function loadCredentials(): Credentials | null {
  const account = getAccount();
  const emailKeys = account === 'test'
    ? ['TICKTICK_TEST_EMAIL', 'TICKTICK_TEST_USERNAME']
    : ['TICKTICK_EMAIL', 'TICKTICK_USERNAME'];
  const passwordKey = account === 'test'
    ? 'TICKTICK_TEST_PASSWORD'
    : 'TICKTICK_PASSWORD';

  let email: string | null = null;
  for (const key of emailKeys) {
    const v = readEnv(key);
    if (v) { email = v; break; }
  }
  const password = readEnv(passwordKey) ?? null;
  if (!email || !password) return null;
  return { email, password };
}

function readEnv(key: string): string | undefined {
  const fromProc = process.env[key];
  if (fromProc && fromProc.length > 0) return fromProc;

  const fromFile = readDotenv()[key];
  if (fromFile && fromFile.length > 0) return fromFile;

  return undefined;
}

let cachedDotenv: Record<string, string> | null = null;

function readDotenv(): Record<string, string> {
  if (cachedDotenv !== null) return cachedDotenv;

  // XDG-compliant location first — shared secrets live here
  const xdgPath = join(homedir(), '.config', 'athena', '.env');
  // ~/.env is a user-owned overlay; values here win over the XDG file
  const homePath = join(homedir(), '.env');

  const merged: Record<string, string> = {};
  for (const path of [xdgPath, homePath]) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf-8');
      Object.assign(merged, parseDotenv(raw));
    } catch {
      // ignore; keep whatever merged successfully so far
    }
  }

  cachedDotenv = merged;
  return cachedDotenv;
}

/**
 * Minimal dotenv parser. Handles:
 *   - KEY=value
 *   - KEY="value with spaces"
 *   - KEY='value with spaces'
 *   - comments starting with #
 *   - blank lines
 *   - trailing whitespace
 * Does NOT handle:
 *   - variable interpolation ($OTHER)
 *   - multi-line values
 *   - escape sequences inside quotes
 * This is deliberate — we want zero surprises on a credential file.
 */
function parseDotenv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) result[key] = value;
  }
  return result;
}

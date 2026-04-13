/**
 * env.ts — load TICKTICK_EMAIL and TICKTICK_PASSWORD.
 *
 * Precedence (first match wins at read time; reads cache both files):
 *   1. process.env (already set, from a parent shell or CLI wrapper)
 *   2. ~/.env — user-owned overlay (optional)
 *   3. ~/.config/PAI/.env — PAI-managed XDG-compliant secrets file
 *   4. undefined → caller decides whether to fail
 *
 * The XDG file is the canonical home for PAI-managed secrets; ~/.env is
 * the user's personal file and is read as an optional overlay so users
 * can keep ~/.env for their own purposes without PAI claiming it.
 *
 * This skill never reads credentials from settings.json or the skill
 * directory itself. If a secret lands in a file tracked by git or a
 * harness config, that's a bug.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Credentials = {
  readonly email: string;
  readonly password: string;
};

/**
 * Load credentials. Returns null if either value is missing — the caller
 * should surface AUTH_MISSING_CREDS with an actionable hint.
 */
export function loadCredentials(): Credentials | null {
  const email =
    readEnv('TICKTICK_EMAIL') ??
    readEnv('TICKTICK_USERNAME') ??
    null;
  const password = readEnv('TICKTICK_PASSWORD') ?? null;
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

  // XDG-compliant location first — PAI's managed secrets live here
  const xdgPath = join(homedir(), '.config', 'PAI', '.env');
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

/**
 * users.ts — persistent cache of TickTick users we've seen, plus a
 * `resolveUser(nameOrId)` helper used by --assignee flags.
 *
 * The cache is populated from two sources:
 *   1. The `whoami` command stores `self: {userId, displayName, username}`
 *      so future invocations can resolve `--assignee me`.
 *   2. The `members list --project X` command upserts every member it sees
 *      into the cache, so subsequent `--assignee Cris` style lookups can
 *      match by display name or email.
 *
 * Storage: <cli-dir>/.session/users.json (0600 perms, same dir as the
 * session blob — both are auth-adjacent and gitignored).
 *
 * Shape:
 *   {
 *     "self": { "userId": 115368611, "displayName": "Matthew", "username": "..." },
 *     "known": [
 *       { "userId": 115368611, "displayName": "Matthew", "username": "..." },
 *       { "userId": 125524115, "displayName": "Cris",    "username": "..." },
 *       ...
 *     ]
 *   }
 *
 * Lookups are case-insensitive and accept partial prefix matches on
 * displayName. Ambiguous matches throw UsageError with the candidate list.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from './errors.ts';
import type { Member, User } from './adapter.ts';

const FILE_MODE = 0o600;

export type KnownUser = {
  readonly userId: number;
  readonly displayName: string | null;
  readonly username: string | null;
};

type UsersCache = {
  self: KnownUser | null;
  known: KnownUser[];
};

// ──────────────────────────────────────────────────────────────────
// Persistence
// ──────────────────────────────────────────────────────────────────

function usersFilePath(): string {
  const here = fileURLToPath(import.meta.url);
  // /.../ticktick-cli/src/users.ts → /.../ticktick-cli/.session/users.json
  const cliDir = dirname(dirname(here));
  return join(cliDir, '.session', 'users.json');
}

function loadCache(): UsersCache {
  const path = usersFilePath();
  if (!existsSync(path)) return { self: null, known: [] };
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { self: null, known: [] };
    const p = parsed as Record<string, unknown>;
    const self = isValidKnownUser(p['self']) ? (p['self'] as KnownUser) : null;
    const known = Array.isArray(p['known'])
      ? (p['known'] as unknown[]).filter(isValidKnownUser).map((u) => u as KnownUser)
      : [];
    return { self, known };
  } catch {
    return { self: null, known: [] };
  }
}

function saveCache(cache: UsersCache): void {
  const path = usersFilePath();
  try {
    writeFileSync(path, JSON.stringify(cache, null, 2), { mode: FILE_MODE });
    chmodSync(path, FILE_MODE);
  } catch {
    // Non-fatal — cache is an optimization, not a correctness dependency
  }
}

function isValidKnownUser(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['userId'] === 'number';
}

// ──────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────

/** Update `self` in the cache after a successful whoami/login. */
export function rememberSelf(user: User): void {
  if (user.userId === null) return;
  const numericId = typeof user.userId === 'string' ? Number.parseInt(user.userId, 10) : user.userId;
  if (!Number.isFinite(numericId)) return;
  const cache = loadCache();
  const self: KnownUser = {
    userId: numericId,
    displayName: user.displayName ?? null,
    username: user.username ?? user.email ?? null,
  };
  cache.self = self;
  upsertKnown(cache, self);
  saveCache(cache);
}

/** Upsert each member into the known-users list. Called after `members list`. */
export function rememberMembers(members: readonly Member[]): void {
  if (members.length === 0) return;
  const cache = loadCache();
  for (const m of members) {
    upsertKnown(cache, {
      userId: m.userId,
      displayName: m.displayName,
      username: m.username,
    });
  }
  saveCache(cache);
}

/** Return the cached self user, or null if whoami hasn't been called yet. */
export function getCachedSelf(): KnownUser | null {
  return loadCache().self;
}

/** Return the full list of cached users. */
export function getCachedUsers(): readonly KnownUser[] {
  return loadCache().known;
}

/**
 * Resolve an identifier to a numeric TickTick userId.
 *
 * Accepts:
 *   - "me"                 → cached self.userId (throws if whoami not run yet)
 *   - "unassign"/"none"    → returns null (caller interprets as "clear")
 *   - "12345"              → parsed as numeric id
 *   - "Cris"               → matched against cached displayName (prefix, case-insensitive)
 *   - "cris@example.com"   → matched against cached username
 *
 * Throws UsageError on ambiguous or unknown identifiers.
 */
export function resolveUser(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new UsageError('Empty user identifier');
  }
  const lc = trimmed.toLowerCase();

  if (lc === 'unassign' || lc === 'none' || lc === 'null') {
    return null;
  }

  if (lc === 'me' || lc === 'self') {
    const self = getCachedSelf();
    if (!self) {
      throw new UsageError(
        'No cached self — run `ticktick whoami` first so I know your userId.',
      );
    }
    return self.userId;
  }

  // Numeric id
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  const known = getCachedUsers();
  const matches = known.filter((u) => {
    const displayMatch =
      u.displayName !== null && u.displayName.toLowerCase().startsWith(lc);
    const usernameMatch =
      u.username !== null && u.username.toLowerCase() === lc;
    return displayMatch || usernameMatch;
  });

  if (matches.length === 0) {
    throw new UsageError(
      `No cached user matches '${trimmed}'. Run \`ticktick members list --project <name>\` on a shared project to populate the cache, or pass a numeric userId.`,
    );
  }
  if (matches.length > 1) {
    const names = matches.map((m) => `${m.displayName ?? '(no name)'} [${m.userId}]`).join(', ');
    throw new UsageError(
      `Ambiguous user '${trimmed}'. Matches: ${names}. Disambiguate by full display name, email, or numeric userId.`,
    );
  }
  return matches[0]!.userId;
}

// ──────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────

function upsertKnown(cache: UsersCache, user: KnownUser): void {
  const idx = cache.known.findIndex((u) => u.userId === user.userId);
  if (idx === -1) {
    cache.known.push(user);
    return;
  }
  // Merge — keep newer non-null displayName / username
  const existing = cache.known[idx]!;
  cache.known[idx] = {
    userId: user.userId,
    displayName: user.displayName ?? existing.displayName,
    username: user.username ?? existing.username,
  };
}

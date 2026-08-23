/**
 * cli.ts — top-level CLI dispatcher.
 *
 * Entry: main(argv) → Promise<number> (exit code). The bin shim awaits this
 * and calls process.exit(). We never call process.exit from inside main so
 * that this module stays testable and composable.
 */

import { loadCredentials } from './env.ts';
import { resolveSessionPath, sanitizeSessionFile } from './session.ts';
import { TickTickClientAdapter, AdapterError, mapLibraryError } from './adapter.ts';
import type { TickTickAdapter } from './adapter.ts';
import { UsageError, getExitCode } from './errors.ts';
import { setDebug, writeError, writeHuman } from './output.ts';
import { getAccount, setAccount } from './context.ts';
import type { Account } from './context.ts';

import * as auth from './commands/auth.ts';
import * as tasks from './commands/tasks.ts';
import * as projects from './commands/projects.ts';
import * as tags from './commands/tags.ts';
import * as checklist from './commands/checklist.ts';
import * as members from './commands/members.ts';
import * as sections from './commands/sections.ts';

// ──────────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────────

export type GlobalOpts = {
  readonly human: boolean;
  readonly debug: boolean;
  readonly account: Account;
};

/**
 * Factory used by every command handler. Loads creds (for the active
 * account, set via context.setAccount), resolves the account-scoped
 * session path, constructs the adapter. Throws AUTH_MISSING_CREDS if
 * either env var is missing.
 */
export function createAdapter(): TickTickAdapter {
  const account = getAccount();
  const creds = loadCredentials();
  if (!creds) {
    const hint = account === 'test'
      ? 'No TickTick TEST credentials. Set TICKTICK_TEST_EMAIL and TICKTICK_TEST_PASSWORD in ~/.config/athena/.env (project-scoped service account).'
      : 'No TickTick credentials. Set TICKTICK_EMAIL and TICKTICK_PASSWORD in ~/.env or ~/.config/athena/.env.';
    throw new AdapterError('AUTH_MISSING_CREDS', hint);
  }
  // Defensive: if the session file on disk is malformed, delete it before
  // the library tries to load it. Otherwise the library crashes deep inside
  // on a missing cookies map.
  sanitizeSessionFile();
  return new TickTickClientAdapter({
    username: creds.email,
    password: creds.password,
    sessionFilePath: resolveSessionPath(),
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  // Global-flag parsing has to be inside the error handler too. It can throw
  // UsageError (an unknown --account value, a --account with no argument), and
  // if that escapes, the CLI dumps a raw stack trace instead of the
  // {ok:false,error:{code}} envelope every caller parses. Errors here are
  // reported with default output settings, since the flags that would
  // configure output are the ones that just failed to parse.
  let opts: GlobalOpts;
  let positional: readonly string[];
  try {
    ({ opts, positional } = parseGlobalFlags(argv));
  } catch (err) {
    writeError(mapAnyError(err));
    return getExitCode(err);
  }

  setDebug(opts.debug);
  setAccount(opts.account);

  if (positional.length === 0 || positional[0] === 'help' || positional[0] === '--help' || positional[0] === '-h') {
    writeHuman(helpText());
    return 0;
  }

  try {
    const [command, ...rest] = positional;
    switch (command) {
      case 'login':
        await auth.login(rest, opts);
        return 0;
      case 'logout':
        await auth.logout(rest, opts);
        return 0;
      case 'whoami':
        await auth.whoami(rest, opts);
        return 0;
      case 'tasks':
        await routeTasks(rest, opts);
        return 0;
      case 'projects':
        await routeProjects(rest, opts);
        return 0;
      case 'tags':
        await routeTags(rest, opts);
        return 0;
      case 'checklist':
        await routeChecklist(rest, opts);
        return 0;
      case 'members':
        await routeMembers(rest, opts);
        return 0;
      case 'sections':
        await routeSections(rest, opts);
        return 0;
      default:
        throw new UsageError(`Unknown command: ${command}. Run 'ticktick help' for usage.`);
    }
  } catch (err) {
    writeError(mapAnyError(err));
    return getExitCode(err);
  }
}

function mapAnyError(err: unknown): unknown {
  if (err instanceof UsageError) return err;
  if (err instanceof AdapterError) return err;
  if (err instanceof Error) return mapLibraryError(err);
  return mapLibraryError(err);
}

// ──────────────────────────────────────────────────────────────────
// Subcommand routing
// ──────────────────────────────────────────────────────────────────

async function routeTasks(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case 'list':
      return tasks.list(rest, opts);
    case 'get':
      return tasks.get(rest, opts);
    case 'create':
      return tasks.create(rest, opts);
    case 'update':
      return tasks.update(rest, opts);
    case 'complete':
      return tasks.complete(rest, opts);
    case 'delete':
      return tasks.remove(rest, opts);
    case 'move':
      return tasks.move(rest, opts);
    case 'pin':
      return tasks.pin(rest, opts);
    case 'unpin':
      return tasks.unpin(rest, opts);
    case 'restore':
      return tasks.restore(rest, opts);
    case 'create-many':
      return tasks.createMany(rest, opts);
    case 'update-many':
      return tasks.updateMany(rest, opts);
    case 'delete-many':
      return tasks.deleteMany(rest, opts);
    case 'complete-many':
      return tasks.completeMany(rest, opts);
    case 'completed':
      return tasks.completed(rest, opts);
    case 'remind':
      return routeTasksRemind(rest, opts);
    case 'location':
      return routeTasksLocation(rest, opts);
    case 'indent':
      return tasks.indent(rest, opts);
    case 'promote':
      return tasks.promote(rest, opts);
    default:
      throw new UsageError(`Unknown tasks subcommand: ${sub}`);
  }
}

async function routeTasksRemind(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'add':
      return tasks.remindAdd(rest, opts);
    case 'remove':
      return tasks.remindRemove(rest, opts);
    case 'clear':
      return tasks.remindClear(rest, opts);
    default:
      throw new UsageError(
        `Unknown 'tasks remind' subcommand: ${sub ?? '(none)'}. Expected: add, remove, clear.`,
      );
  }
}

// Location reminders (geofences). Set/replace happens via `tasks create`
// and `tasks update` with the --location-* flags; only `clear` needs a
// dedicated subcommand because the patch endpoint silently no-ops every
// "null" shape. See `locationClear` in commands/tasks.ts for the adapter
// escape hatch.
async function routeTasksLocation(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'clear':
      return tasks.locationClear(rest, opts);
    default:
      throw new UsageError(
        `Unknown 'tasks location' subcommand: ${sub ?? '(none)'}. Expected: clear.`,
      );
  }
}

async function routeProjects(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case 'list':
      return projects.list(rest, opts);
    case 'get':
      return projects.get(rest, opts);
    case 'create':
      return projects.create(rest, opts);
    case 'update':
      return projects.update(rest, opts);
    case 'delete':
      return projects.remove(rest, opts);
    default:
      throw new UsageError(`Unknown projects subcommand: ${sub}`);
  }
}

async function routeTags(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case 'list':
      return tags.list(rest, opts);
    case 'create':
      return tags.create(rest, opts);
    case 'update':
      return tags.update(rest, opts);
    case 'delete':
      return tags.remove(rest, opts);
    case 'rename':
      return tags.rename(rest, opts);
    case 'merge':
      return tags.merge(rest, opts);
    default:
      throw new UsageError(`Unknown tags subcommand: ${sub}`);
  }
}

async function routeChecklist(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case 'list':
      return checklist.list(rest, opts);
    case 'add':
      return checklist.add(rest, opts);
    case 'complete':
      return checklist.complete(rest, opts);
    case 'delete':
      return checklist.remove(rest, opts);
    default:
      throw new UsageError(`Unknown checklist subcommand: ${sub}`);
  }
}

async function routeMembers(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case 'list':
      return members.list(rest, opts);
    case 'remove':
      return members.remove(rest, opts);
    default:
      throw new UsageError(`Unknown members subcommand: ${sub}`);
  }
}

async function routeSections(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case 'list':
      return sections.list(rest, opts);
    case 'create':
      return sections.create(rest, opts);
    case 'rename':
      return sections.rename(rest, opts);
    case 'delete':
      return sections.remove(rest, opts);
    case 'move':
      return sections.move(rest, opts);
    default:
      throw new UsageError(`Unknown sections subcommand: ${sub}`);
  }
}

// ──────────────────────────────────────────────────────────────────
// Arg parsing
// ──────────────────────────────────────────────────────────────────

/**
 * Strip global flags (--human, --debug, --json, --no-color, --account)
 * from argv, returning the cleaned positional array plus the parsed opts.
 *
 * --account accepts either `--account <value>` or `--account=<value>` and
 * defaults to 'live' if omitted. Unknown values raise UsageError so an
 * agent typo doesn't silently default to the wrong account.
 */
function parseGlobalFlags(argv: readonly string[]): {
  opts: GlobalOpts;
  positional: readonly string[];
} {
  let human = false;
  let debug = false;
  let account: Account = 'live';
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--human') { human = true; continue; }
    if (token === '--debug') { debug = true; continue; }
    if (token === '--json' || token === '--no-color') continue;
    if (token === '--account') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError('--account requires a value: live or test');
      }
      account = parseAccountValue(next);
      i += 1;
      continue;
    }
    if (token.startsWith('--account=')) {
      account = parseAccountValue(token.slice('--account='.length));
      continue;
    }
    positional.push(token);
  }
  return { opts: { human, debug, account }, positional };
}

function parseAccountValue(raw: string): Account {
  const v = raw.trim().toLowerCase();
  if (v === 'live' || v === 'test') return v;
  throw new UsageError(`Unknown --account value '${raw}'. Expected 'live' or 'test'.`);
}

/**
 * Parse command-level flags: --key value and --key=value.
 * Repeated keys (e.g. --tags) accept CSV values, not repeated flags.
 * Returns a { flags, positional } pair.
 *
 * Exported so command handlers share one parser.
 */
export function parseCommandArgs(argv: readonly string[]): {
  flags: Record<string, string>;
  positional: readonly string[];
} {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        const key = token.slice(2, eq);
        const value = token.slice(eq + 1);
        flags[key] = value;
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = 'true';
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

/**
 * Collect every occurrence of a repeated flag, in order. Used by flags
 * that should accept either repeated `--key v1 --key v2` form OR
 * comma-separated `--key v1,v2` form (or both mixed). The returned array
 * is the union of all values, with empty entries skipped.
 *
 * Examples:
 *   --remind 15m --remind 1d        → ['15m', '1d']
 *   --remind 15m,1d                 → ['15m', '1d']
 *   --remind 15m,1h --remind 1d     → ['15m', '1h', '1d']
 *
 * Why a separate scan instead of using parseCommandArgs(): the existing
 * parser collapses repeated keys into a single Record<string,string>,
 * which is fine for flags like `--title` but loses information for
 * `--remind`. We scan argv twice rather than complicate the main parser
 * — adding multi-valued flag plumbing to parseCommandArgs would touch
 * every existing handler.
 */
export function collectRepeatedFlag(argv: readonly string[], name: string): readonly string[] {
  const key = `--${name}`;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    let raw: string | undefined;
    if (token === key) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        raw = next;
        i += 1;
      }
    } else if (token.startsWith(`${key}=`)) {
      raw = token.slice(key.length + 1);
    }
    if (raw === undefined) continue;
    for (const piece of raw.split(',')) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}

/**
 * Require a specific flag from a parsed flags object; throws UsageError if missing.
 */
export function requireFlag(
  flags: Record<string, string>,
  name: string,
  hint?: string,
): string {
  const v = flags[name];
  if (v === undefined || v === '') {
    throw new UsageError(
      `Missing required flag: --${name}${hint ? ` (${hint})` : ''}`,
    );
  }
  return v;
}

// ──────────────────────────────────────────────────────────────────
// Help text
// ──────────────────────────────────────────────────────────────────

function helpText(): string {
  return `ticktick — CLI for TickTick (unofficial v2 API)

USAGE
  ticktick <command> [subcommand] [flags]

GLOBAL FLAGS
  --human            Pretty-print instead of JSON (default: JSON)
  --debug            Emit debug info to stderr
  --json             Explicit JSON output (default)
  --no-color         No color in output (no-op for now)
  --account live|test
                     Select which TickTick account to use. Default: live
                     (your personal account, reads TICKTICK_EMAIL /
                     TICKTICK_PASSWORD from ~/.env). Pass 'test' to use
                     the dedicated service account (reads
                     TICKTICK_TEST_EMAIL / TICKTICK_TEST_PASSWORD from
                     ~/.config/athena/.env). Session files are namespaced
                     per account so the two never clobber each other.

COMMANDS
  login                                    Force fresh login (seeds session)
  logout                                   Delete local session
  whoami                                   Verify session, show user + age

  tasks list [flags]                       List tasks
    --project <id|name>                      filter by project
    --status open|completed|abandoned|all    filter by status (default: open)
    --due today|tomorrow|overdue|week|next7days|none
                                             filter by due window
    --tag <name>                             filter by tag
    --pinned                                 only pinned tasks
    --section <id|name>                      filter by section (requires --project)
    --assignee me|<id>|<name>|unassign       filter by assignee (unassign = unassigned only)
    --limit N                                cap result count
    --parent <taskId>                        only direct children of <taskId>
    --top-level                              only tasks with no parent
    --tree                                   recursive tree (requires --parent)
  tasks get --id <taskId>                  Fetch a single task
  tasks create --title <t> [flags]         Create a task
    --project <id|name> --content <md>
    --due <ISO> --priority none|low|medium|high
    --tags a,b,c --section <id|name> --assignee me|<id>|<name>
    --repeat <RRULE> --repeat-end <ISO>
    --remind <offset>                      time-based reminder, repeatable
                                           or CSV. Formats: at-start, 15m,
                                           1h, 1d, 1d9h, or raw TRIGGER:...
                                           Requires --due.
    --parent <taskId>                      create as a child of <taskId>
                                           (project auto-resolved from parent)
    --location-lat <num>                   geofence reminder latitude in [-90, 90].
    --location-lng <num>                   geofence reminder longitude in [-180, 180].
                                           --location-lat and --location-lng MUST
                                           be passed together (half a coordinate
                                           is silently coerced to null and the
                                           geofence won't fire).
    --location-radius <m>                  geofence radius in meters (default 100,
                                           positive integer). 50m is tight, 200m
                                           is lenient.
    --location-trigger arrive|leave        when to fire (default: arrive).
                                           arrive = entering the radius;
                                           leave = exiting it.
    --location-alias <text>                friendly label for the location, e.g.
                                           "Home" / "Work" / "Dry Cleaner".
    --location-address <text>              full street address (display only).
  tasks update --id <id> --project <pid> [flags]
                                           Update a task (same optional fields).
                                           --remind REPLACES all existing
                                           reminders (use 'tasks remind add'
                                           to append, 'tasks remind clear'
                                           to remove all).
                                           --location-* sets/replaces the geofence
                                           in place. Use 'tasks location clear' to
                                           remove a geofence — passing
                                           --location-* flags can only set, not clear.
                                           Note: --parent is NOT accepted on update;
                                           use 'tasks indent' / 'tasks promote'.
  tasks complete --id <id> [--project <pid>]
                                           Mark a task done
  tasks delete --id <id> [--project <pid>]
                                           Delete (abandon) a task. Children are
                                           ORPHANED (not cascade-deleted) — they
                                           remain with their parentId pointing at
                                           the deleted parent.
  tasks move --id <id> --to <id|name> [--from <pid>]
                                           Move to a different list.
                                           ⚠️ returns a NEW task id (copy+delete)
  tasks pin --id <id> [--project <pid>]    Pin a task to the top
  tasks unpin --id <id> [--project <pid>]  Unpin a task
  tasks restore --id <id> --project <pid>  Restore a deleted task (id required —
                                           trash listing is broken upstream)
  tasks completed [flags]                  List completed tasks
    --project <id|name> --limit N            paginated iterator mode
    --from <ISO> --to <ISO> [--limit N]      statistics range mode (mutex w/ --project)
  tasks create-many --file <path.json>     Bulk-create tasks from a JSON array
  tasks update-many --file <path.json>     Bulk-update (each entry needs id+projectId+title)
  tasks delete-many --ids id1,id2,id3      Bulk-delete (project resolved per id)
  tasks complete-many --ids id1,id2,id3    Bulk-complete (project resolved per id)
  tasks remind add --id <id> --offset <off> [--project <pid>]
                                           Append a reminder to an existing task.
  tasks remind remove --id <id> --offset <off> [--project <pid>]
                                           Remove a specific reminder by offset.
  tasks remind clear --id <id> [--project <pid>]
                                           Remove all reminders from a task.
  tasks location clear --id <id> [--project <pid>]
                                           Remove the geofence reminder from a task.
                                           (Set/replace via 'tasks create' or
                                           'tasks update' with --location-* flags.)
  tasks indent --id <id> --under <parentId> [--project <pid>]
                                           Make <id> a nested subtask of <parentId>.
                                           In-place (id is preserved).
  tasks promote --id <id> [--project <pid>]
                                           Make <id> top-level (clear its parent).
                                           In-place (id is preserved).

  projects list                            List all projects
  projects get --id <id|name>              Fetch one project
  projects create --name <name> [flags]    Create a project
    --color <#RRGGBB> --kind task|note --view list|kanban|timeline
  projects update --id <id|name> [flags]   Update a project (--name/--color/--view/--kind)
  projects delete --id <id|name> --confirm
                                           Delete a project AND all its tasks.
                                           --confirm is required.

  sections list --project <id|name>        List kanban sections (columns) in a project
  sections create --project <id|name> --name <text> [--before|--after <id|name>]
                                           Create a new section; optional placement
                                           relative to an anchor section.
  sections rename --project <id|name> --section <id|name> --to <text>
                                           Rename an existing section.
  sections delete --project <id|name> --section <id|name> [--reassign <id|name>] --confirm
                                           Delete a section. Destructive: requires
                                           --confirm. Without --reassign, tasks in
                                           the section are orphaned (columnId cleared).
                                           With --reassign, tasks are moved to the
                                           named target section first.
  sections move --project <id|name> --section <id|name> --before|--after <id|name>
                                           Reorder a section by placing it before
                                           or after another section in the list.

  members list --project <id|name>         List members of a shared project
  members remove --project <id|name> --user <id|name|me> [--force]
                                           Revoke a user's access to a shared
                                           project. Dry-run by default; pass
                                           --force to actually remove.

  tags list                                List all tags
  tags create --name <slug> [flags]        Create a tag (--label, --color, --parent)
  tags update --name <slug> [flags]        Update a tag (--label / --color / --parent)
  tags delete --name <slug>                Delete a tag
  tags rename --name <old> --to <new>      Rename a tag (slug-to-slug)
  tags merge --from <a> --to <b>           Merge tag a into b (a is removed)

  checklist list --task <id>               List checklist items inside a task
  checklist add --task <id> --project <pid> --title <t>
  checklist complete --task <id> --project <pid> --item <itemId>
  checklist delete --task <id> --project <pid> --item <itemId>

EXIT CODES
  0  success
  1  unexpected error
  2  usage error
  3  auth error (missing creds, failed login, expired session)
  4  not found
  5  network / rate limited
  6  validation error

ENVIRONMENT
  Live account (default, --account live):
    TICKTICK_EMAIL    (or TICKTICK_USERNAME) — user's personal account
    TICKTICK_PASSWORD
  Test account (--account test):
    TICKTICK_TEST_EMAIL    (or TICKTICK_TEST_USERNAME) — project service account
    TICKTICK_TEST_PASSWORD
  Both: reads ~/.config/athena/.env first, then overlays ~/.env.
  TICKTICK_DEBUG=1    forces --debug

NOTES
  - Nested subtasks: use --parent on create, or 'tasks indent' / 'tasks promote'
    to re-parent existing tasks. Distinct from checklist items (use 'checklist').
  - Parent-delete ORPHANS children. They remain with parentId pointing at the
    deleted parent. Promote or delete them explicitly if needed.
  - 2FA / MFA on your account is NOT supported.
`;
}

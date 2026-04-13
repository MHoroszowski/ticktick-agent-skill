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
};

/**
 * Factory used by every command handler. Loads creds, resolves session
 * path, constructs the adapter. Throws AUTH_MISSING_CREDS if either env
 * var is missing.
 */
export function createAdapter(): TickTickAdapter {
  const creds = loadCredentials();
  if (!creds) {
    throw new AdapterError(
      'AUTH_MISSING_CREDS',
      'No TickTick credentials. Set TICKTICK_EMAIL and TICKTICK_PASSWORD in ~/.env or ~/.config/PAI/.env.',
    );
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
  const { opts, positional } = parseGlobalFlags(argv);
  setDebug(opts.debug);

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
    default:
      throw new UsageError(`Unknown tasks subcommand: ${sub}`);
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
 * Strip global flags (--human, --debug, --json, --no-color) from argv,
 * returning the cleaned positional array plus the parsed opts.
 */
function parseGlobalFlags(argv: readonly string[]): {
  opts: GlobalOpts;
  positional: readonly string[];
} {
  let human = false;
  let debug = false;
  const positional: string[] = [];
  for (const token of argv) {
    switch (token) {
      case '--human':
        human = true;
        break;
      case '--debug':
        debug = true;
        break;
      case '--json':
      case '--no-color':
        // no-op: JSON is the default, color isn't emitted
        break;
      default:
        positional.push(token);
    }
  }
  return { opts: { human, debug }, positional };
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
  return `ticktick — PAI skill CLI for TickTick (unofficial v2 API)

USAGE
  ticktick <command> [subcommand] [flags]

GLOBAL FLAGS
  --human        Pretty-print instead of JSON (default: JSON)
  --debug        Emit debug info to stderr
  --json         Explicit JSON output (default)
  --no-color     No color in output (no-op for now)

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
  tasks get --id <taskId>                  Fetch a single task
  tasks create --title <t> [flags]         Create a task
    --project <id|name> --content <md>
    --due <ISO> --priority none|low|medium|high
    --tags a,b,c --section <id|name> --assignee me|<id>|<name>
    --repeat <RRULE> --repeat-end <ISO>
  tasks update --id <id> --project <pid> [flags]
                                           Update a task (same optional fields)
  tasks complete --id <id> [--project <pid>]
                                           Mark a task done
  tasks delete --id <id> [--project <pid>]
                                           Delete (abandon) a task
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
  TICKTICK_EMAIL      (or TICKTICK_USERNAME) — PAI reads ~/.config/PAI/.env
  TICKTICK_PASSWORD    first, then overlays ~/.env (if present) for user overrides
  TICKTICK_DEBUG=1    forces --debug

NOTES
  - Nested subtasks (parentId-based child tasks) are NOT yet supported.
    See README.md for the follow-up work required.
  - 2FA / MFA on your account is NOT supported.
`;
}

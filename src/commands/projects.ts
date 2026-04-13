/**
 * commands/projects.ts — project list, get, create, update, delete.
 *
 * `delete` is gated on an explicit `--confirm` flag because deleting a
 * project also deletes every task in it. Without --confirm we print the
 * affected task count and exit non-zero (validation error / exit 6).
 */

import { createAdapter, parseCommandArgs, requireFlag } from '../cli.ts';
import { AdapterError } from '../adapter.ts';
import { writeOk, writeHuman, formatProjectsTable } from '../output.ts';
import { UsageError } from '../errors.ts';
import type { GlobalOpts } from '../cli.ts';
import type { TickTickAdapter, ProjectDraft, ProjectPatch } from '../adapter.ts';

export async function list(_argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const adapter = createAdapter();
  const projects = await adapter.listProjects();

  if (opts.human) {
    writeHuman(formatProjectsTable(projects));
    return;
  }
  writeOk({ count: projects.length, projects });
}

export async function get(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const idOrName = requireFlag(flags, 'id', 'project id or name');
  const adapter = createAdapter();
  const project = await adapter.getProject(idOrName);
  if (project === null) {
    throw new AdapterError('NOT_FOUND', `Project '${idOrName}' not found`);
  }

  if (opts.human) {
    writeHuman(formatProjectsTable([project]));
    return;
  }
  writeOk({ project });
}

export async function create(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const name = requireFlag(flags, 'name', 'project name');

  const draft: ProjectDraft = {
    name,
    ...(flags.color !== undefined && { color: flags.color }),
    ...(flags.kind !== undefined && { kind: parseProjectKind(flags.kind) }),
    ...(flags.view !== undefined && { viewMode: parseProjectView(flags.view) }),
  };

  const adapter = createAdapter();
  const project = await adapter.createProject(draft);

  if (opts.human) {
    writeHuman(`Created project ${project.id}: ${project.name}`);
    return;
  }
  writeOk({ project });
}

export async function update(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const idOrName = requireFlag(flags, 'id', 'project id or name');

  if (
    flags.name === undefined &&
    flags.color === undefined &&
    flags.view === undefined &&
    flags.kind === undefined
  ) {
    throw new UsageError(
      'projects update needs at least one of --name, --color, --view, --kind to change.',
    );
  }

  const adapter = createAdapter();
  const id = await resolveProjectId(adapter, idOrName);

  // The TickTick API requires the full name on every update — fetch the
  // current value if the caller didn't supply a new one.
  let name = flags.name;
  if (name === undefined) {
    const current = await adapter.getProject(id);
    if (current === null) {
      throw new AdapterError('NOT_FOUND', `Project ${id} not found`);
    }
    name = current.name;
  }

  const patch: ProjectPatch = {
    id,
    name,
    ...(flags.color !== undefined && { color: flags.color }),
    ...(flags.kind !== undefined && { kind: parseProjectKind(flags.kind) }),
    ...(flags.view !== undefined && { viewMode: parseProjectView(flags.view) }),
  };

  await adapter.updateProject(patch);

  if (opts.human) {
    writeHuman(`Updated project ${id}`);
    return;
  }
  writeOk({ projectId: id, patch });
}

export async function remove(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const idOrName = requireFlag(flags, 'id', 'project id or name');
  const adapter = createAdapter();
  const id = await resolveProjectId(adapter, idOrName);

  // Count the tasks that would be destroyed alongside the project. Used
  // by both the warning path and the success message.
  const tasks = await adapter.listTasks({ projectId: id, status: 'all' });
  const taskCount = tasks.length;

  if (flags.confirm !== 'true') {
    // Validation error — exit code 6 — surfaced via the JSON error envelope.
    // The warning is in the message so it's visible in --human and in JSON
    // alike.
    throw new AdapterError(
      'VALIDATION',
      `Refusing to delete project ${id}: it contains ${taskCount} task${taskCount === 1 ? '' : 's'} which will be permanently destroyed. Re-run with --confirm to proceed.`,
    );
  }

  await adapter.deleteProject(id);

  if (opts.human) {
    writeHuman(`Deleted project ${id} (${taskCount} task${taskCount === 1 ? '' : 's'} also removed)`);
    return;
  }
  writeOk({ deleted: id, taskCount });
}

// ──────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────

async function resolveProjectId(adapter: TickTickAdapter, idOrName: string): Promise<string> {
  if (/^[a-f0-9]{24}$/i.test(idOrName)) return idOrName;
  const project = await adapter.getProject(idOrName);
  if (!project) {
    throw new UsageError(
      `No project found matching '${idOrName}'. Run \`ticktick projects list\` to see available projects.`,
    );
  }
  return project.id;
}

function parseProjectKind(value: string): 'TASK' | 'NOTE' {
  const v = value.toUpperCase();
  if (v === 'TASK' || v === 'NOTE') return v;
  throw new UsageError(`--kind must be one of: task, note. Got: ${value}`);
}

function parseProjectView(value: string): 'list' | 'kanban' | 'timeline' {
  const v = value.toLowerCase();
  if (v === 'list' || v === 'kanban' || v === 'timeline') return v;
  throw new UsageError(`--view must be one of: list, kanban, timeline. Got: ${value}`);
}

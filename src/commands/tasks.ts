/**
 * commands/tasks.ts — task CRUD and move.
 */

import { createAdapter, collectRepeatedFlag, parseCommandArgs, requireFlag } from '../cli.ts';
import { AdapterError, hydratePatch } from '../adapter.ts';
import { UsageError } from '../errors.ts';
import { writeOk, writeHuman, formatTasksTable } from '../output.ts';
import { parseTriggerOffset, formatTriggerOffset } from '../reminders.ts';
import { resolveUser } from '../users.ts';
import type { GlobalOpts } from '../cli.ts';
import type {
  TickTickAdapter,
  TaskDraft,
  TaskPatch,
  TaskPriorityName,
  TaskStatus,
  TaskListFilters,
} from '../adapter.ts';

// ──────────────────────────────────────────────────────────────────
// list
// ──────────────────────────────────────────────────────────────────

export async function list(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const adapter = createAdapter();

  const projectId =
    flags.project !== undefined ? await resolveProjectId(adapter, flags.project) : undefined;

  let limit: number | undefined;
  if (flags.limit !== undefined) {
    const n = Number.parseInt(flags.limit, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new UsageError(`--limit must be a non-negative integer, got: ${flags.limit}`);
    }
    limit = n;
  }

  const filters: TaskListFilters = {
    ...(projectId !== undefined && { projectId }),
    ...(flags.status !== undefined && { status: parseStatusFilter(flags.status) }),
    ...(flags.due !== undefined && { due: parseDueFilter(flags.due) }),
    ...(flags.tag !== undefined && { tag: flags.tag }),
    ...(limit !== undefined && { limit }),
  };

  const result = await adapter.listTasks(filters);

  if (opts.human) {
    writeHuman(formatTasksTable(result));
    return;
  }
  writeOk({ count: result.length, tasks: result });
}

// ──────────────────────────────────────────────────────────────────
// get
// ──────────────────────────────────────────────────────────────────

export async function get(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const adapter = createAdapter();
  const task = await adapter.getTask(id);
  if (task === null) {
    throw new AdapterError('NOT_FOUND', `Task ${id} not found`);
  }
  if (opts.human) {
    writeHuman(formatTasksTable([task]));
    return;
  }
  writeOk({ task });
}

// ──────────────────────────────────────────────────────────────────
// create
// ──────────────────────────────────────────────────────────────────

export async function create(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const title = requireFlag(flags, 'title', 'task title');

  const adapter = createAdapter();
  const projectId =
    flags.project !== undefined ? await resolveProjectId(adapter, flags.project) : undefined;

  const assignee = flags.assignee !== undefined ? resolveUser(flags.assignee) : undefined;

  if (flags.section !== undefined && projectId === undefined) {
    throw new UsageError(
      '--section requires --project so the section can be resolved within that project.',
    );
  }
  const columnId =
    flags.section !== undefined && projectId !== undefined
      ? await resolveSectionId(adapter, projectId, flags.section)
      : undefined;

  // Reminders: collected from repeated --remind / CSV. Triggers a
  // due-date sanity check — TickTick allows reminders on tasks with no
  // due date, but they will silently never fire. Surface this clearly
  // rather than letting the user set a reminder that does nothing.
  const remindOffsets = collectRepeatedFlag(argv, 'remind');
  if (remindOffsets.length > 0 && flags.due === undefined) {
    throw new UsageError(
      "--remind requires --due. TickTick reminders only fire on tasks that have a due date; setting reminders without a due date is a no-op.",
    );
  }
  const reminders =
    remindOffsets.length > 0 ? remindOffsets.map(parseTriggerOffset) : undefined;

  const draft: TaskDraft = {
    title,
    ...(projectId !== undefined && { projectId }),
    ...(flags.content !== undefined && { content: flags.content }),
    ...(flags.priority !== undefined && { priority: parsePriority(flags.priority) }),
    ...(flags.due !== undefined && { dueDate: flags.due }),
    ...(flags.start !== undefined && { startDate: flags.start }),
    ...(flags['all-day'] === 'true' && { isAllDay: true }),
    ...(flags.tags !== undefined && { tags: parseTagList(flags.tags) }),
    ...(flags.repeat !== undefined && { repeatFlag: flags.repeat }),
    ...(flags.assignee !== undefined && { assignee }),
    ...(columnId !== undefined && { columnId }),
    ...(reminders !== undefined && { reminders }),
  };

  const task = await adapter.createTask(draft);

  if (opts.human) {
    const remindSuffix =
      task.reminders.length > 0
        ? ` (reminders: ${task.reminders.map(formatTriggerOffset).join(', ')})`
        : '';
    writeHuman(`Created task ${task.id}: ${task.title}${remindSuffix}`);
    return;
  }
  writeOk({ task });
}

// ──────────────────────────────────────────────────────────────────
// update
// ──────────────────────────────────────────────────────────────────

export async function update(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const projectId = requireFlag(
    flags,
    'project',
    'project id — fetch the task first with `tasks get --id <id>` if you need it',
  );
  const title = flags.title;
  if (title === undefined) {
    throw new UsageError(
      'Missing --title for tasks update. Pass the new (or existing) title explicitly.',
    );
  }

  const adapter = createAdapter();
  const assignee = flags.assignee !== undefined ? resolveUser(flags.assignee) : undefined;

  // For update, projectId is required as a flag, so resolve it first so
  // --section can be fuzzy-matched within the correct project.
  const resolvedProjectId = await resolveProjectId(adapter, projectId);
  const columnId =
    flags.section !== undefined
      ? await resolveSectionId(adapter, resolvedProjectId, flags.section)
      : undefined;

  // Reminders on update have REPLACE semantics — locked product decision.
  // When --remind is present we hydrate the full task body via the
  // shared adapter helper, because TickTick's PUT endpoint wipes any
  // field the caller didn't re-send. See hydratePatch in adapter.ts.
  const remindOffsets = collectRepeatedFlag(argv, 'remind');
  const remindFlagPresent = remindOffsets.length > 0;
  const reminders = remindFlagPresent ? remindOffsets.map(parseTriggerOffset) : undefined;
  const currentForRemind = remindFlagPresent ? await adapter.getTask(id) : null;
  const previousReminders = currentForRemind?.reminders;

  const userOverlay: Partial<TaskPatch> = {
    ...(flags.content !== undefined && { content: flags.content }),
    ...(flags.priority !== undefined && { priority: parsePriority(flags.priority) }),
    ...(flags.due !== undefined && { dueDate: flags.due }),
    ...(flags.start !== undefined && { startDate: flags.start }),
    ...(flags['all-day'] === 'true' && { isAllDay: true }),
    ...(flags.tags !== undefined && { tags: parseTagList(flags.tags) }),
    ...(flags.repeat !== undefined && { repeatFlag: flags.repeat }),
    ...(flags.assignee !== undefined && { assignee }),
    ...(columnId !== undefined && { columnId }),
  };

  const patch: TaskPatch =
    currentForRemind && reminders !== undefined
      ? hydratePatch(currentForRemind, resolvedProjectId, reminders, { title, ...userOverlay })
      : {
          id,
          projectId: resolvedProjectId,
          title,
          ...userOverlay,
        };

  const task = await adapter.updateTask(patch);

  if (opts.human) {
    let line = `Updated task ${task.id}: ${task.title}`;
    if (reminders !== undefined) {
      const prev = previousReminders ?? [];
      const next = task.reminders;
      const nextHuman = next.length > 0 ? next.map(formatTriggerOffset).join(', ') : '(none)';
      line += `\nReplaced ${prev.length} existing reminder${prev.length === 1 ? '' : 's'} → [${nextHuman}]`;
    }
    writeHuman(line);
    return;
  }
  writeOk({
    task,
    ...(reminders !== undefined && { previousReminders: previousReminders ?? [] }),
  });
}

// ──────────────────────────────────────────────────────────────────
// complete
// ──────────────────────────────────────────────────────────────────

export async function complete(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.completeTask(id, projectId);

  if (opts.human) {
    writeHuman(`Completed task ${id}`);
    return;
  }
  writeOk({ taskId: id });
}

// ──────────────────────────────────────────────────────────────────
// delete
// ──────────────────────────────────────────────────────────────────

export async function remove(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.deleteTask(id, projectId);

  if (opts.human) {
    writeHuman(`Deleted task ${id}`);
    return;
  }
  writeOk({ deleted: id });
}

// ──────────────────────────────────────────────────────────────────
// move
// ──────────────────────────────────────────────────────────────────

export async function move(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const toRaw = requireFlag(flags, 'to', 'destination project id or name');

  const adapter = createAdapter();
  const fromProjectId = await resolveTaskProjectId(adapter, id, flags.from);
  const toProjectId = await resolveProjectId(adapter, toRaw);

  const result = await adapter.moveTask(id, fromProjectId, toProjectId);

  if (opts.human) {
    writeHuman(
      `Moved task (previousId=${result.previousId}) → newId=${result.task.id} in project ${result.task.projectId}`,
    );
    return;
  }
  writeOk({
    task: result.task,
    previousId: result.previousId,
    note:
      'TickTick implements moves as copy+delete. The task has a NEW id. Update any references to the old id.',
  });
}

// ──────────────────────────────────────────────────────────────────
// remind add / remove / clear
// ──────────────────────────────────────────────────────────────────

export async function remindAdd(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const offsetRaw = requireFlag(flags, 'offset', 'reminder offset (e.g. 15m, 1h, 1d)');
  const trigger = parseTriggerOffset(offsetRaw);

  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);
  const before = await adapter.getTask(id);
  if (before === null) throw new AdapterError('NOT_FOUND', `Task ${id} not found`);
  // No-op if the trigger is already present — TickTick allows duplicate
  // reminders but they're user-confusing.
  const next = before.reminders.includes(trigger)
    ? before.reminders
    : [...before.reminders, trigger];
  // Reminders only fire on tasks that have a due date; surface the gap
  // without blocking since the user may set a due date later.
  const noDue = before.dueDate === null;

  const task = await adapter.setReminders(before, projectId, next);

  if (opts.human) {
    const human = task.reminders.map(formatTriggerOffset).join(', ') || '(none)';
    let line = `Added reminder ${formatTriggerOffset(trigger)} → task now has [${human}]`;
    if (noDue) line += `\n⚠️  Task has no due date — reminder will not fire.`;
    writeHuman(line);
    return;
  }
  writeOk({
    task,
    addedReminder: trigger,
    ...(noDue && { warning: 'Task has no due date — reminder will not fire.' }),
  });
}

export async function remindRemove(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const offsetRaw = requireFlag(flags, 'offset', 'reminder offset to remove');
  const trigger = parseTriggerOffset(offsetRaw);

  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);
  const before = await adapter.getTask(id);
  if (before === null) throw new AdapterError('NOT_FOUND', `Task ${id} not found`);
  const wasPresent = before.reminders.includes(trigger);
  const next = before.reminders.filter((t) => t !== trigger);

  const task = await adapter.setReminders(before, projectId, next);

  if (opts.human) {
    const remaining = task.reminders.map(formatTriggerOffset).join(', ') || '(none)';
    if (!wasPresent) {
      writeHuman(
        `No reminder matching ${formatTriggerOffset(trigger)} on task ${id} — nothing changed. Current: [${remaining}]`,
      );
    } else {
      writeHuman(`Removed reminder ${formatTriggerOffset(trigger)} → task now has [${remaining}]`);
    }
    return;
  }
  writeOk({ task, removedReminder: trigger, matched: wasPresent });
}

export async function remindClear(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');

  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);
  const before = await adapter.getTask(id);
  if (before === null) throw new AdapterError('NOT_FOUND', `Task ${id} not found`);
  const previousReminders = before.reminders;

  const task = await adapter.setReminders(before, projectId, []);

  if (opts.human) {
    writeHuman(
      `Cleared ${previousReminders.length} reminder${previousReminders.length === 1 ? '' : 's'} from task ${id}`,
    );
    return;
  }
  writeOk({ task, previousReminders });
}

// ──────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────

async function resolveProjectId(adapter: TickTickAdapter, idOrName: string): Promise<string> {
  // Fast path: if it looks like an ObjectId (24 hex chars), treat as ID.
  if (/^[a-f0-9]{24}$/i.test(idOrName)) return idOrName;
  const project = await adapter.getProject(idOrName);
  if (!project) {
    throw new UsageError(
      `No project found matching '${idOrName}'. Run \`ticktick projects list\` to see available projects.`,
    );
  }
  return project.id;
}

async function resolveSectionId(
  adapter: TickTickAdapter,
  projectId: string,
  idOrName: string,
): Promise<string> {
  // Fast path: if it looks like an ObjectId (24 hex chars), treat as ID.
  if (/^[a-f0-9]{24}$/i.test(idOrName)) return idOrName;

  const sections = await adapter.listSections(projectId);
  const query = idOrName.toLowerCase();

  // Exact (case-insensitive) name match wins outright.
  const exact = sections.filter((s) => s.name.toLowerCase() === query);
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) {
    const names = exact.map((s) => `${s.name} (${s.id})`).join(', ');
    throw new UsageError(
      `Multiple sections named '${idOrName}' in project ${projectId}: ${names}. Pass --section <id> to disambiguate.`,
    );
  }

  // Prefix match (case-insensitive) as a fallback.
  const prefix = sections.filter((s) => s.name.toLowerCase().startsWith(query));
  if (prefix.length === 1) return prefix[0]!.id;
  if (prefix.length > 1) {
    const names = prefix.map((s) => `${s.name} (${s.id})`).join(', ');
    throw new UsageError(
      `Ambiguous --section '${idOrName}' in project ${projectId}: ${names}. Pass --section <id> to disambiguate.`,
    );
  }

  throw new AdapterError(
    'NOT_FOUND',
    `No section matching '${idOrName}' in project ${projectId}. Run \`ticktick sections list --project ${projectId}\` to see available sections.`,
  );
}

async function resolveTaskProjectId(
  adapter: TickTickAdapter,
  taskId: string,
  explicit: string | undefined,
): Promise<string> {
  if (explicit !== undefined) return resolveProjectId(adapter, explicit);
  const task = await adapter.getTask(taskId);
  if (task === null) {
    throw new AdapterError('NOT_FOUND', `Task ${taskId} not found`);
  }
  return task.projectId;
}

function parsePriority(value: string): TaskPriorityName {
  const v = value.toLowerCase();
  if (v === 'none' || v === 'low' || v === 'medium' || v === 'high') return v;
  throw new UsageError(`--priority must be one of: none, low, medium, high. Got: ${value}`);
}

function parseStatusFilter(value: string): TaskStatus | 'all' {
  const v = value.toLowerCase();
  if (v === 'open' || v === 'completed' || v === 'abandoned' || v === 'all') return v;
  throw new UsageError(`--status must be one of: open, completed, abandoned, all. Got: ${value}`);
}

function parseDueFilter(value: string): 'today' | 'overdue' | 'week' {
  const v = value.toLowerCase();
  if (v === 'today' || v === 'overdue' || v === 'week') return v;
  throw new UsageError(`--due must be one of: today, overdue, week. Got: ${value}`);
}

function parseTagList(value: string): readonly string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}


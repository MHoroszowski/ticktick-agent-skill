/**
 * commands/tasks.ts — task CRUD and move.
 */

import { createAdapter, collectRepeatedFlag, parseCommandArgs, requireFlag } from '../cli.ts';
import { AdapterError, hydratePatch } from '../adapter.ts';
import { UsageError } from '../errors.ts';
import { writeOk, writeHuman, formatTasksTable, formatTaskTree } from '../output.ts';
import { parseTriggerOffset, formatTriggerOffset } from '../reminders.ts';
import { resolveUser } from '../users.ts';
import type { GlobalOpts } from '../cli.ts';
import type {
  TickTickAdapter,
  Task,
  TaskDraft,
  TaskPatch,
  TaskPriorityName,
  TaskStatus,
  TaskListFilters,
  TaskLocation,
  DueFilter,
} from '../adapter.ts';

// ──────────────────────────────────────────────────────────────────
// Location flag parsing — shared between create and update
// ──────────────────────────────────────────────────────────────────

/**
 * Parse the `--location-*` flag set into a {@link TaskLocation} object,
 * or return `undefined` if no location flags were passed. Throws
 * `UsageError` if any location flag is present but `--location-lat` and
 * `--location-lng` aren't both given (the long-form keys are required as
 * a pair — half a coordinate is silently coerced to nulls server-side
 * and produces an unfireable geofence).
 *
 * Flag defaults (only applied when at least one location flag is passed):
 *   --location-radius   → 100 (meters)
 *   --location-trigger  → "arrive" (transitionType: 1)
 *   --location-alias    → null
 *   --location-address  → null
 *
 * Note on key naming: TickTick's wire shape uses `loc.longitude` and
 * `loc.latitude` — sending `loc.lng/lat` causes the server to silently
 * coerce both to null. That's why the CLI flags are explicit
 * `--location-lat` / `--location-lng` (matching common short usage) but
 * the adapter writes the long-form keys on the wire.
 */
function buildLocationFromFlags(
  flags: Record<string, string>,
): TaskLocation | undefined {
  const LOCATION_FLAG_KEYS = [
    'location-lat',
    'location-lng',
    'location-radius',
    'location-trigger',
    'location-alias',
    'location-address',
  ];
  const anyLocationFlag = LOCATION_FLAG_KEYS.some((k) => flags[k] !== undefined);
  if (!anyLocationFlag) return undefined;

  const latRaw = flags['location-lat'];
  const lngRaw = flags['location-lng'];
  if (latRaw === undefined || lngRaw === undefined) {
    const missing: string[] = [];
    if (latRaw === undefined) missing.push('--location-lat');
    if (lngRaw === undefined) missing.push('--location-lng');
    throw new UsageError(
      `${missing.join(' and ')} required when any --location-* flag is passed. ` +
        `--location-lat and --location-lng must always be passed together — half a ` +
        `coordinate is coerced to null server-side and the geofence won't fire.`,
    );
  }

  const lat = Number.parseFloat(latRaw);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new UsageError(`--location-lat must be a number in [-90, 90], got: ${latRaw}`);
  }
  const lng = Number.parseFloat(lngRaw);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new UsageError(`--location-lng must be a number in [-180, 180], got: ${lngRaw}`);
  }

  const radiusRaw = flags['location-radius'];
  let radius = 100;
  if (radiusRaw !== undefined) {
    const n = Number.parseInt(radiusRaw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new UsageError(
        `--location-radius must be a positive integer (meters), got: ${radiusRaw}`,
      );
    }
    radius = n;
  }

  const triggerRaw = flags['location-trigger'] ?? 'arrive';
  let transitionType: 1 | 2;
  if (triggerRaw === 'arrive') transitionType = 1;
  else if (triggerRaw === 'leave') transitionType = 2;
  else {
    throw new UsageError(
      `--location-trigger must be 'arrive' or 'leave', got: ${triggerRaw}`,
    );
  }

  return {
    alias: flags['location-alias'] ?? null,
    loc: { longitude: lng, latitude: lat },
    radius,
    transitionType,
    shortAddress: null,
    address: flags['location-address'] ?? null,
    removed: false,
  };
}

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

  // --section filter: must know the project so the section name resolves
  // within the right column list. Section ids are globally scoped but
  // name-based lookup needs the project context.
  if (flags.section !== undefined && projectId === undefined) {
    throw new UsageError(
      '--section requires --project so the section can be resolved within that project.',
    );
  }
  const sectionId =
    flags.section !== undefined && projectId !== undefined
      ? await resolveSectionId(adapter, projectId, flags.section)
      : undefined;

  // --assignee filter: resolve via users.ts. 'me'/'self' → cached self,
  // 'unassign'/'none'/'null' → filter to unassigned tasks only.
  let assigneeFilter: number | null | undefined;
  if (flags.assignee !== undefined) {
    assigneeFilter = resolveUser(flags.assignee);
  }

  const wantParent = flags.parent;
  const wantTopLevel = flags['top-level'] === 'true';
  const wantTree = flags.tree === 'true';

  if (wantParent !== undefined && wantTopLevel) {
    throw new UsageError('--parent and --top-level are mutually exclusive.');
  }
  if (wantTree && wantParent === undefined) {
    throw new UsageError(
      '--tree requires --parent <id> so the recursion has a starting root.',
    );
  }

  const filters: TaskListFilters = {
    ...(projectId !== undefined && { projectId }),
    ...(flags.status !== undefined && { status: parseStatusFilter(flags.status) }),
    ...(flags.due !== undefined && { due: parseDueFilter(flags.due) }),
    ...(flags.tag !== undefined && { tag: flags.tag }),
    ...(flags.pinned === 'true' && { pinned: true }),
    ...(sectionId !== undefined && { sectionId }),
    ...(assigneeFilter !== undefined && { assignee: assigneeFilter }),
    ...(limit !== undefined && { limit }),
    ...(wantParent !== undefined && { parentId: wantParent }),
    ...(wantTopLevel && { topLevelOnly: true }),
  };

  // Tree mode: fetch ALL tasks once, then walk the parent chain client-side.
  // The /api/v3/batch/check/0 endpoint returns the entire account list in
  // one call, so this is no more expensive than the flat path.
  if (wantTree) {
    const all = await adapter.listTasks({
      ...(projectId !== undefined && { projectId }),
      status: 'all',
    });
    const tree = buildSubtree(all, wantParent!);
    if (opts.human) {
      writeHuman(formatTaskTree(tree));
      return;
    }
    writeOk({ count: countNodes(tree), tree });
    return;
  }

  const result = await adapter.listTasks(filters);

  if (opts.human) {
    writeHuman(formatTasksTable(result));
    return;
  }
  writeOk({ count: result.length, tasks: result });
}

// ──────────────────────────────────────────────────────────────────
// Tree helpers — used by `tasks list --parent <id> --tree`
// ──────────────────────────────────────────────────────────────────

export type TaskNode = {
  readonly task: Task;
  readonly children: readonly TaskNode[];
};

function buildSubtree(all: readonly Task[], rootId: string): readonly TaskNode[] {
  // Group tasks by their parentId for O(N) lookup.
  const byParent = new Map<string, Task[]>();
  for (const t of all) {
    if (t.parentId === null) continue;
    const bucket = byParent.get(t.parentId);
    if (bucket) {
      bucket.push(t);
    } else {
      byParent.set(t.parentId, [t]);
    }
  }
  const walk = (parentId: string): readonly TaskNode[] => {
    const direct = byParent.get(parentId) ?? [];
    return direct.map((t) => ({ task: t, children: walk(t.id) }));
  };
  return walk(rootId);
}

function countNodes(nodes: readonly TaskNode[]): number {
  let total = 0;
  for (const n of nodes) {
    total += 1 + countNodes(n.children);
  }
  return total;
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

  // --parent makes this a nested subtask. We resolve the parent first so
  // we can auto-fill the project from the parent if the user didn't pass
  // --project explicitly. This matches the natural intent: "add a child
  // under <parent>" doesn't need to know which list the parent lives in.
  let parentId: string | undefined;
  let parentProjectId: string | undefined;
  if (flags.parent !== undefined) {
    const parent = await adapter.getTask(flags.parent);
    if (!parent) {
      throw new AdapterError(
        'NOT_FOUND',
        `--parent ${flags.parent}: parent task not found.`,
      );
    }
    parentId = parent.id;
    parentProjectId = parent.projectId;
  }

  let projectId: string | undefined;
  if (flags.project !== undefined) {
    projectId = await resolveProjectId(adapter, flags.project);
  } else if (parentProjectId !== undefined) {
    projectId = parentProjectId;
  }

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

  // Geofence reminder flags. All six --location-* flags collapse into one
  // TaskLocation object. Throws USAGE if --location-lat and --location-lng
  // aren't passed together when any location flag is present.
  const location = buildLocationFromFlags(flags);

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
    ...(flags['repeat-end'] !== undefined && { repeatEndDate: flags['repeat-end'] }),
    ...(flags.assignee !== undefined && { assignee }),
    ...(columnId !== undefined && { columnId }),
    ...(reminders !== undefined && { reminders }),
    ...(parentId !== undefined && { parentId }),
    ...(location !== undefined && { location }),
  };

  const task = await adapter.createTask(draft);

  if (opts.human) {
    const remindSuffix =
      task.reminders.length > 0
        ? ` (reminders: ${task.reminders.map(formatTriggerOffset).join(', ')})`
        : '';
    if (parentId !== undefined) {
      writeHuman(`Created subtask ${task.id} under ${parentId}: ${task.title}${remindSuffix}`);
    } else {
      writeHuman(`Created task ${task.id}: ${task.title}${remindSuffix}`);
    }
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

  // Geofence reminder flags. Collapses all six --location-* flags into one
  // TaskLocation. Same UsageError behaviour as on create. Same wipe risk
  // as reminders: a sparse `{id, projectId, title, location}` body
  // wipes other fields server-side, so when --location-* is present we
  // also hydrate the full body — same hydratePatch helper, with an
  // empty reminders pass-through when --remind wasn't given.
  const location = buildLocationFromFlags(flags);
  const locationFlagPresent = location !== undefined;

  // Hydrate when EITHER --remind OR --location-* is present. The patch
  // endpoint's full-body-wipe semantics affect both kinds of updates.
  const needsHydration = remindFlagPresent || locationFlagPresent;
  const currentForHydrate = needsHydration ? await adapter.getTask(id) : null;
  if (needsHydration && currentForHydrate === null) {
    throw new AdapterError('NOT_FOUND', `Task ${id} not found`);
  }
  const previousReminders = remindFlagPresent ? currentForHydrate?.reminders : undefined;

  const userOverlay: Partial<TaskPatch> = {
    ...(flags.content !== undefined && { content: flags.content }),
    ...(flags.priority !== undefined && { priority: parsePriority(flags.priority) }),
    ...(flags.due !== undefined && { dueDate: flags.due }),
    ...(flags.start !== undefined && { startDate: flags.start }),
    ...(flags['all-day'] === 'true' && { isAllDay: true }),
    ...(flags.tags !== undefined && { tags: parseTagList(flags.tags) }),
    ...(flags.repeat !== undefined && { repeatFlag: flags.repeat }),
    ...(flags['repeat-end'] !== undefined && { repeatEndDate: flags['repeat-end'] }),
    ...(flags.assignee !== undefined && { assignee }),
    ...(columnId !== undefined && { columnId }),
    ...(location !== undefined && { location }),
  };

  // When hydrating, hydratePatch carries forward the existing reminders
  // (via its `reminders` parameter) — pass `previousReminders ?? []`
  // so a location-only update preserves whatever reminders were there.
  // When --remind is also present, the new reminders array replaces them.
  const patch: TaskPatch = currentForHydrate
    ? hydratePatch(
        currentForHydrate,
        resolvedProjectId,
        reminders ?? currentForHydrate.reminders,
        { title, ...userOverlay },
      )
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

  // Look up children before delete so we can warn the caller — TickTick
  // ORPHANS children (does NOT cascade-delete). The children remain with
  // their parentId pointing at the now-deleted parent id, which the
  // TickTick UI typically renders as top-level. Surfacing this lets the
  // agent decide whether to follow up with promote/cascade-delete.
  const orphanedChildren = await adapter.listSubtasks(id);

  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.deleteTask(id, projectId);

  if (opts.human) {
    if (orphanedChildren.length > 0) {
      writeHuman(
        `Deleted task ${id}. Note: ${orphanedChildren.length} child task(s) were orphaned (not cascade-deleted) — they still exist with their parentId pointing at the deleted parent.`,
      );
    } else {
      writeHuman(`Deleted task ${id}`);
    }
    return;
  }
  writeOk({
    deleted: id,
    ...(orphanedChildren.length > 0 && {
      orphanedChildren: orphanedChildren.map((c) => c.id),
      orphanNote:
        'TickTick does not cascade-delete nested subtasks. The listed children still exist with parentId pointing at the deleted parent. Promote or delete them explicitly if you want them gone.',
    }),
  });
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
// location clear — remove the geofence reminder from a task
// ──────────────────────────────────────────────────────────────────

/**
 * Remove the geofence reminder from a task. Set/replace happens via
 * `tasks create`/`tasks update --location-*`; only the clear case needs
 * a dedicated command because the patch endpoint silently no-ops every
 * "null" shape we tried (location:null, location:{}, location:{loc:null}).
 * The adapter routes this through the batch-endpoint full-body-replace
 * pattern with `removed: true` on the existing location object — same
 * escape-hatch shape as `unpinTask`.
 */
export async function locationClear(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');

  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);
  const before = await adapter.getTask(id);
  if (before === null) throw new AdapterError('NOT_FOUND', `Task ${id} not found`);
  const previousLocation = before.location;

  const task = await adapter.clearLocation(id, projectId);

  if (opts.human) {
    if (previousLocation === null) {
      writeHuman(`Task ${id} has no location to clear`);
    } else {
      const label =
        previousLocation.alias ??
        (previousLocation.loc
          ? `${previousLocation.loc.latitude.toFixed(4)},${previousLocation.loc.longitude.toFixed(4)}`
          : 'unknown');
      writeHuman(`Cleared location (${label}) from task ${id}`);
    }
    return;
  }
  writeOk({ task, previousLocation });
}

// ──────────────────────────────────────────────────────────────────
// indent — re-parent an existing task under a different parent
// ──────────────────────────────────────────────────────────────────

export async function indent(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id to indent');
  const under = requireFlag(flags, 'under', 'new parent task id');

  if (id === under) {
    throw new UsageError(
      `--id and --under cannot be the same task (${id}). A task cannot be its own parent.`,
    );
  }

  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.indentTask(id, projectId, under);

  if (opts.human) {
    writeHuman(`Indented ${id} under ${under}`);
    return;
  }
  writeOk({ taskId: id, parentId: under });
}

// ──────────────────────────────────────────────────────────────────
// promote — clear a task's parentId, making it top-level
// ──────────────────────────────────────────────────────────────────

export async function promote(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id to promote');

  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.promoteTask(id, projectId);

  if (opts.human) {
    writeHuman(`Promoted ${id} to top-level`);
    return;
  }
  writeOk({ taskId: id, parentId: null });
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

function parseDueFilter(value: string): DueFilter {
  const v = value.toLowerCase();
  if (
    v === 'today' ||
    v === 'tomorrow' ||
    v === 'overdue' ||
    v === 'week' ||
    v === 'next7days' ||
    v === 'none'
  ) {
    return v;
  }
  throw new UsageError(
    `--due must be one of: today, tomorrow, overdue, week, next7days, none. Got: ${value}`,
  );
}

function parseTagList(value: string): readonly string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// ──────────────────────────────────────────────────────────────────
// pin / unpin
// ──────────────────────────────────────────────────────────────────

export async function pin(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.pinTask(id, projectId);

  if (opts.human) {
    writeHuman(`Pinned task ${id}`);
    return;
  }
  writeOk({ taskId: id, projectId, pinned: true });
}

export async function unpin(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  const adapter = createAdapter();
  const projectId = await resolveTaskProjectId(adapter, id, flags.project);

  await adapter.unpinTask(id, projectId);

  if (opts.human) {
    writeHuman(`Unpinned task ${id}`);
    return;
  }
  writeOk({ taskId: id, projectId, pinned: false });
}

// ──────────────────────────────────────────────────────────────────
// restore (out of trash — explicit id required)
// ──────────────────────────────────────────────────────────────────

export async function restore(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const id = requireFlag(flags, 'id', 'task id');
  // No auto-resolve: the task is in trash, getTask() can't find it.
  const projectIdFlag = requireFlag(
    flags,
    'project',
    'project id — required because trash listing is broken',
  );
  const adapter = createAdapter();
  const projectId = await resolveProjectId(adapter, projectIdFlag);
  await adapter.restoreTask(id, projectId);

  if (opts.human) {
    writeHuman(`Restored task ${id} in project ${projectId}`);
    return;
  }
  writeOk({ taskId: id, projectId, restored: true });
}

// ──────────────────────────────────────────────────────────────────
// bulk: create-many / update-many / delete-many / complete-many
// ──────────────────────────────────────────────────────────────────

export async function createMany(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const file = requireFlag(flags, 'file', 'path to JSON file containing an array of TaskDraft objects');
  const drafts = await loadJsonFile<readonly Record<string, unknown>[]>(file);
  if (!Array.isArray(drafts)) {
    throw new UsageError(`--file must contain a JSON array of task drafts. Got: ${typeof drafts}`);
  }
  if (drafts.length === 0) {
    throw new UsageError(`--file ${file} is an empty array; nothing to create.`);
  }

  const adapter = createAdapter();
  const normalized: TaskDraft[] = [];
  for (const [i, raw] of drafts.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      throw new UsageError(`drafts[${i}] is not an object`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.title !== 'string' || r.title.length === 0) {
      throw new UsageError(`drafts[${i}].title must be a non-empty string`);
    }
    // Resolve project name → id (one round-trip per unique name; ok for
    // small batches). Pre-resolved ids pass through untouched.
    const projectId =
      typeof r.projectId === 'string' && r.projectId.length > 0
        ? await resolveProjectId(adapter, r.projectId)
        : undefined;
    const draft: TaskDraft = {
      title: r.title,
      ...(projectId !== undefined && { projectId }),
      ...(typeof r.content === 'string' && { content: r.content }),
      ...(typeof r.priority === 'string' && { priority: parsePriority(r.priority) }),
      ...(typeof r.dueDate === 'string' && { dueDate: r.dueDate }),
      ...(typeof r.startDate === 'string' && { startDate: r.startDate }),
      ...(typeof r.isAllDay === 'boolean' && { isAllDay: r.isAllDay }),
      ...(Array.isArray(r.tags) && { tags: r.tags as readonly string[] }),
      ...(typeof r.repeatFlag === 'string' && { repeatFlag: r.repeatFlag }),
      ...(typeof r.repeatEndDate === 'string' && { repeatEndDate: r.repeatEndDate }),
    };
    normalized.push(draft);
  }

  await adapter.createTasksBatch(normalized);

  if (opts.human) {
    writeHuman(`Created ${normalized.length} task${normalized.length === 1 ? '' : 's'} from ${file}`);
    return;
  }
  writeOk({ count: normalized.length, source: file });
}

export async function updateMany(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const file = requireFlag(flags, 'file', 'path to JSON file containing an array of TaskPatch objects');
  const patches = await loadJsonFile<readonly Record<string, unknown>[]>(file);
  if (!Array.isArray(patches)) {
    throw new UsageError(`--file must contain a JSON array of task patches. Got: ${typeof patches}`);
  }
  if (patches.length === 0) {
    throw new UsageError(`--file ${file} is an empty array; nothing to update.`);
  }

  const adapter = createAdapter();
  const normalized: TaskPatch[] = [];
  for (const [i, raw] of patches.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      throw new UsageError(`patches[${i}] is not an object`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id.length === 0) {
      throw new UsageError(`patches[${i}].id is required`);
    }
    if (typeof r.projectId !== 'string' || r.projectId.length === 0) {
      throw new UsageError(`patches[${i}].projectId is required`);
    }
    if (typeof r.title !== 'string' || r.title.length === 0) {
      throw new UsageError(
        `patches[${i}].title is required (TickTick rejects updates with no title)`,
      );
    }
    const projectId = await resolveProjectId(adapter, r.projectId);
    const patch: TaskPatch = {
      id: r.id,
      projectId,
      title: r.title,
      ...(typeof r.content === 'string' && { content: r.content }),
      ...(typeof r.priority === 'string' && { priority: parsePriority(r.priority) }),
      ...(typeof r.dueDate === 'string' && { dueDate: r.dueDate }),
      ...(typeof r.startDate === 'string' && { startDate: r.startDate }),
      ...(typeof r.isAllDay === 'boolean' && { isAllDay: r.isAllDay }),
      ...(Array.isArray(r.tags) && { tags: r.tags as readonly string[] }),
      ...(typeof r.repeatFlag === 'string' && { repeatFlag: r.repeatFlag }),
      ...(typeof r.repeatEndDate === 'string' && { repeatEndDate: r.repeatEndDate }),
    };
    normalized.push(patch);
  }

  await adapter.updateTasksBatch(normalized);

  if (opts.human) {
    writeHuman(`Updated ${normalized.length} task${normalized.length === 1 ? '' : 's'} from ${file}`);
    return;
  }
  writeOk({ count: normalized.length, source: file });
}

export async function deleteMany(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const idsRaw = requireFlag(flags, 'ids', 'comma-separated task ids');
  const ids = parseIdList(idsRaw);
  if (ids.length === 0) {
    throw new UsageError('--ids must contain at least one task id');
  }

  const adapter = createAdapter();
  // If --project is provided, every id is assumed to live there (no
  // round-trip resolution). Useful for bulk-deleting completed tasks,
  // which getTask() can't see because it reads the open-tasks index.
  const explicitProjectId =
    flags.project !== undefined ? await resolveProjectId(adapter, flags.project) : undefined;
  const items =
    explicitProjectId !== undefined
      ? ids.map((taskId) => ({ taskId, projectId: explicitProjectId }))
      : await resolveBatchItems(adapter, ids);

  await adapter.deleteTasksBatch(items);

  if (opts.human) {
    writeHuman(`Deleted ${items.length} task${items.length === 1 ? '' : 's'}`);
    return;
  }
  writeOk({ count: items.length, items });
}

export async function completeMany(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const idsRaw = requireFlag(flags, 'ids', 'comma-separated task ids');
  const ids = parseIdList(idsRaw);
  if (ids.length === 0) {
    throw new UsageError('--ids must contain at least one task id');
  }

  const adapter = createAdapter();
  // Same --project shortcut as deleteMany — see comment there.
  const explicitProjectId =
    flags.project !== undefined ? await resolveProjectId(adapter, flags.project) : undefined;
  const items =
    explicitProjectId !== undefined
      ? ids.map((taskId) => ({ taskId, projectId: explicitProjectId }))
      : await resolveBatchItems(adapter, ids);

  await adapter.completeTasksBatch(items);

  if (opts.human) {
    writeHuman(`Completed ${items.length} task${items.length === 1 ? '' : 's'}`);
    return;
  }
  writeOk({ count: items.length, items });
}

// ──────────────────────────────────────────────────────────────────
// completed — paginated iterator OR statistics range
// ──────────────────────────────────────────────────────────────────

export async function completed(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);

  const hasFrom = flags.from !== undefined;
  const hasTo = flags.to !== undefined;
  const hasProject = flags.project !== undefined;

  if (hasFrom !== hasTo) {
    throw new UsageError('--from and --to must be passed together (closed range).');
  }
  if (hasFrom && hasProject) {
    throw new UsageError(
      '--from/--to (statistics range) and --project (paginated iterator) are mutually exclusive. Pick one mode.',
    );
  }

  let limit: number | undefined;
  if (flags.limit !== undefined) {
    const n = Number.parseInt(flags.limit, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new UsageError(`--limit must be a non-negative integer, got: ${flags.limit}`);
    }
    limit = n;
  }

  const adapter = createAdapter();

  let result;
  let mode: 'iterator' | 'statistics';
  if (hasFrom && hasTo) {
    mode = 'statistics';
    result = await adapter.listCompletedTasks({
      from: flags.from!,
      to: flags.to!,
      ...(limit !== undefined && { limit }),
    });
  } else {
    mode = 'iterator';
    const projectId = hasProject ? await resolveProjectId(adapter, flags.project!) : undefined;
    result = await adapter.listCompletedTasks({
      ...(projectId !== undefined && { projectId }),
      ...(limit !== undefined && { limit }),
    });
  }

  if (opts.human) {
    writeHuman(formatTasksTable(result));
    return;
  }
  writeOk({ mode, count: result.length, tasks: result });
}

// ──────────────────────────────────────────────────────────────────
// shared helpers (only used by the new bulk handlers above)
// ──────────────────────────────────────────────────────────────────

function parseIdList(value: string): readonly string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

async function loadJsonFile<T>(path: string): Promise<T> {
  let text: string;
  try {
    const file = Bun.file(path);
    text = await file.text();
  } catch (err) {
    throw new UsageError(
      `--file ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new UsageError(
      `--file ${path} contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve a list of task ids into {taskId, projectId} pairs by fetching
 * each task. One round-trip per id — fine for the v1.3 batch sizes the
 * plan envisions; the FOLLOWUPS file should track caching this if batches
 * grow large. Throws NOT_FOUND on the first id that can't be resolved.
 */
async function resolveBatchItems(
  adapter: TickTickAdapter,
  ids: readonly string[],
): Promise<readonly { taskId: string; projectId: string }[]> {
  const items: { taskId: string; projectId: string }[] = [];
  for (const taskId of ids) {
    const task = await adapter.getTask(taskId);
    if (task === null) {
      throw new AdapterError('NOT_FOUND', `Task ${taskId} not found (cannot resolve project)`);
    }
    items.push({ taskId, projectId: task.projectId });
  }
  return items;
}


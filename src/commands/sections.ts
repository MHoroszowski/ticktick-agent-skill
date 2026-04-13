/**
 * commands/sections.ts — list + full CRUD of sections (kanban columns).
 *
 * All operations go through the adapter which hits the batch-envelope
 * `POST /api/v2/column` endpoint for mutations (see adapter.ts for the raw
 * endpoint shapes and gotchas). Reads go through `GET /api/v2/column`.
 *
 * Create/rename/reorder return `{section: {id, projectId, name, sortOrder}}`.
 * Delete returns `{section: {id, ...}, reassignedTaskCount}` when
 * `--reassign` is used, otherwise just `{deleted: id}`.
 */

import { createAdapter, parseCommandArgs, requireFlag } from '../cli.ts';
import { AdapterError } from '../adapter.ts';
import { UsageError } from '../errors.ts';
import { writeOk, writeHuman } from '../output.ts';
import type { GlobalOpts } from '../cli.ts';
import type { Section, TickTickAdapter } from '../adapter.ts';

export async function list(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const projectArg = requireFlag(flags, 'project', 'project id or name');

  const adapter = createAdapter();
  const projectId = await resolveProjectId(adapter, projectArg);

  const sections = await adapter.listSections(projectId);

  if (opts.human) {
    writeHuman(formatSectionsTable(sections));
    return;
  }
  writeOk({ count: sections.length, projectId, sections });
}

// ──────────────────────────────────────────────────────────────────
// create
// ──────────────────────────────────────────────────────────────────

export async function create(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const projectArg = requireFlag(flags, 'project', 'project id or name');
  const name = requireFlag(flags, 'name', 'section name');

  const adapter = createAdapter();
  const projectId = await resolveProjectId(adapter, projectArg);

  // --after / --before let the caller place the new section relative to an
  // existing one. Without either, the adapter picks a sortOrder past the
  // last existing section so it lands at the end.
  if (flags.after !== undefined && flags.before !== undefined) {
    throw new UsageError('Pass only one of --after / --before, not both.');
  }

  let sortOrder: number | undefined;
  if (flags.after !== undefined || flags.before !== undefined) {
    const anchorArg = (flags.after ?? flags.before)!;
    const mode: 'after' | 'before' = flags.after !== undefined ? 'after' : 'before';
    const sections = await adapter.listSections(projectId);
    const anchor = resolveSectionAmong(sections, anchorArg);
    sortOrder = pickSortOrder(sections, anchor, mode);
  }

  const section = await adapter.createSection(projectId, name, sortOrder);

  if (opts.human) {
    writeHuman(`Created section ${section.id}: ${section.name}`);
    return;
  }
  writeOk({ section });
}

// ──────────────────────────────────────────────────────────────────
// rename
// ──────────────────────────────────────────────────────────────────

export async function rename(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const projectArg = requireFlag(flags, 'project', 'project id or name');
  const sectionArg = requireFlag(flags, 'section', 'section id or name');
  const to = requireFlag(flags, 'to', 'new section name');

  const adapter = createAdapter();
  const projectId = await resolveProjectId(adapter, projectArg);
  const sectionId = await resolveSectionId(adapter, projectId, sectionArg);

  const section = await adapter.renameSection(projectId, sectionId, to);

  if (opts.human) {
    writeHuman(`Renamed section ${section.id} → ${section.name}`);
    return;
  }
  writeOk({ section });
}

// ──────────────────────────────────────────────────────────────────
// delete  (exposed as `sections delete`, implemented as `remove`)
// ──────────────────────────────────────────────────────────────────

export async function remove(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const projectArg = requireFlag(flags, 'project', 'project id or name');
  const sectionArg = requireFlag(flags, 'section', 'section id or name');
  const confirm = flags.confirm === 'true';

  const adapter = createAdapter();
  const projectId = await resolveProjectId(adapter, projectArg);
  const sectionId = await resolveSectionId(adapter, projectId, sectionArg);

  // Count the tasks currently in the section so we can surface impact even
  // without --confirm (dry-run preview) and so the post-delete summary is
  // meaningful.
  const currentTasks = await adapter.listTasks({ projectId, sectionId, status: 'all' });
  const taskCount = currentTasks.length;

  // Optional --reassign: move tasks to the named target section FIRST, then
  // delete the now-empty section. TickTick's delete endpoint has no
  // server-side merge parameter — this is a pure client-side two-step.
  let reassignTargetId: string | undefined;
  if (flags.reassign !== undefined) {
    reassignTargetId = await resolveSectionId(adapter, projectId, flags.reassign);
    if (reassignTargetId === sectionId) {
      throw new UsageError(
        `--reassign target is the same as --section. Pick a different target section.`,
      );
    }
  }

  if (!confirm) {
    const action = reassignTargetId
      ? `move ${taskCount} task(s) to section ${reassignTargetId}, then delete`
      : taskCount > 0
        ? `DELETE ${taskCount} task(s) (they will be orphaned — columnId cleared but tasks remain in the project)`
        : 'delete (section is empty)';
    const msg =
      `Refusing to delete section ${sectionId} in project ${projectId} without --confirm. ` +
      `Effect: ${action}. Re-run with --confirm to execute.`;
    throw new UsageError(msg);
  }

  let reassignedTaskCount = 0;
  if (reassignTargetId !== undefined && taskCount > 0) {
    for (const task of currentTasks) {
      await adapter.updateTask({
        id: task.id,
        projectId,
        title: task.title,
        columnId: reassignTargetId,
      });
      reassignedTaskCount += 1;
    }
  }

  await adapter.deleteSection(projectId, sectionId);

  if (opts.human) {
    if (reassignTargetId !== undefined) {
      writeHuman(
        `Deleted section ${sectionId}. Reassigned ${reassignedTaskCount} task(s) to section ${reassignTargetId}.`,
      );
    } else if (taskCount > 0) {
      writeHuman(
        `Deleted section ${sectionId}. ${taskCount} task(s) were orphaned (columnId cleared).`,
      );
    } else {
      writeHuman(`Deleted section ${sectionId}.`);
    }
    return;
  }
  writeOk({
    deleted: sectionId,
    projectId,
    orphanedTaskCount: reassignTargetId === undefined ? taskCount : 0,
    reassignedTaskCount,
    ...(reassignTargetId !== undefined && { reassignedTo: reassignTargetId }),
  });
}

// ──────────────────────────────────────────────────────────────────
// move (reorder) — `sections move --section X --before|--after Y`
// ──────────────────────────────────────────────────────────────────

export async function move(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const projectArg = requireFlag(flags, 'project', 'project id or name');
  const sectionArg = requireFlag(flags, 'section', 'section id or name to move');

  const hasBefore = flags.before !== undefined;
  const hasAfter = flags.after !== undefined;
  if (hasBefore === hasAfter) {
    throw new UsageError(
      'sections move requires exactly one of --before <section> or --after <section>.',
    );
  }
  const anchorArg = (flags.before ?? flags.after)!;
  const mode: 'before' | 'after' = hasBefore ? 'before' : 'after';

  const adapter = createAdapter();
  const projectId = await resolveProjectId(adapter, projectArg);
  const sectionId = await resolveSectionId(adapter, projectId, sectionArg);

  const sections = await adapter.listSections(projectId);
  const anchor = resolveSectionAmong(sections, anchorArg);
  if (anchor.id === sectionId) {
    throw new UsageError(
      `Cannot move a section relative to itself. Pick a different --${mode} target.`,
    );
  }

  const newSortOrder = pickSortOrder(sections, anchor, mode);
  const section = await adapter.reorderSection(projectId, sectionId, newSortOrder);

  if (opts.human) {
    writeHuman(
      `Moved section ${section.id} (${section.name}) ${mode} ${anchor.id} → sortOrder=${newSortOrder}`,
    );
    return;
  }
  writeOk({ section });
}

// ──────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────

async function resolveProjectId(
  adapter: TickTickAdapter,
  idOrName: string,
): Promise<string> {
  if (/^[a-f0-9]{24}$/i.test(idOrName)) return idOrName;
  const project = await adapter.getProject(idOrName);
  if (!project) {
    throw new AdapterError(
      'NOT_FOUND',
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
  if (/^[a-f0-9]{24}$/i.test(idOrName)) return idOrName;
  const sections = await adapter.listSections(projectId);
  return resolveSectionAmong(sections, idOrName).id;
}

/**
 * Locate a section among an already-fetched list. Accepts a 24-hex id or a
 * name (case-insensitive exact match preferred, then case-insensitive prefix
 * match). Throws on zero matches or ambiguity.
 */
function resolveSectionAmong(
  sections: readonly Section[],
  idOrName: string,
): Section {
  if (/^[a-f0-9]{24}$/i.test(idOrName)) {
    const byId = sections.find((s) => s.id === idOrName);
    if (byId) return byId;
    throw new AdapterError(
      'NOT_FOUND',
      `No section with id '${idOrName}' in this project.`,
    );
  }
  const query = idOrName.toLowerCase();
  const exact = sections.filter((s) => s.name.toLowerCase() === query);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    const names = exact.map((s) => `${s.name} (${s.id})`).join(', ');
    throw new UsageError(
      `Multiple sections named '${idOrName}': ${names}. Pass the id to disambiguate.`,
    );
  }
  const prefix = sections.filter((s) => s.name.toLowerCase().startsWith(query));
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) {
    const names = prefix.map((s) => `${s.name} (${s.id})`).join(', ');
    throw new UsageError(
      `Ambiguous section name '${idOrName}': ${names}. Pass the id to disambiguate.`,
    );
  }
  throw new AdapterError(
    'NOT_FOUND',
    `No section matching '${idOrName}' in this project.`,
  );
}

/**
 * Compute a sortOrder that places a moved/new section before or after an
 * anchor, using the halfway-between convention. TickTick uses huge integer
 * gaps (often 2^16 multiples) for insertions, so we:
 *   - before: pick midpoint between the anchor and its predecessor. If the
 *     anchor is the first section, pick `anchor - 2^16`.
 *   - after: pick midpoint between the anchor and its successor. If the
 *     anchor is the last section, pick `anchor + 2^16`.
 *
 * sortOrder is a signed int in TickTick, but the API accepts floats as well —
 * we round to integer to stay compatible with the observed backing store.
 */
function pickSortOrder(
  sections: readonly Section[],
  anchor: Section,
  mode: 'before' | 'after',
): number {
  const sorted = [...sections].sort((a, b) => {
    const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });
  const anchorIdx = sorted.findIndex((s) => s.id === anchor.id);
  if (anchorIdx === -1) {
    // Shouldn't happen — anchor came from this list — but be defensive.
    return (anchor.sortOrder ?? 0) + (mode === 'after' ? 1 << 16 : -(1 << 16));
  }
  const anchorOrder = sorted[anchorIdx]!.sortOrder ?? 0;
  const GAP = 1 << 16;

  if (mode === 'before') {
    const prev = anchorIdx === 0 ? undefined : sorted[anchorIdx - 1];
    if (!prev) return anchorOrder - GAP;
    const prevOrder = prev.sortOrder ?? (anchorOrder - GAP * 2);
    return Math.round((prevOrder + anchorOrder) / 2);
  }
  // mode === 'after'
  const next = anchorIdx === sorted.length - 1 ? undefined : sorted[anchorIdx + 1];
  if (!next) return anchorOrder + GAP;
  const nextOrder = next.sortOrder ?? (anchorOrder + GAP * 2);
  return Math.round((anchorOrder + nextOrder) / 2);
}

function formatSectionsTable(sections: readonly Section[]): string {
  if (sections.length === 0) {
    return '(no sections — this project has no kanban columns)';
  }
  const header = `${'SORT'.padEnd(5)} ${'SECTION ID'.padEnd(26)} NAME`;
  const divider = '─'.repeat(Math.min(80, header.length));
  const sorted = [...sections].sort((a, b) => {
    const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });
  const rows = sorted.map((s) => {
    const sort = String(s.sortOrder ?? '').padEnd(5);
    const id = s.id.padEnd(26);
    return `${sort} ${id} ${s.name}`;
  });
  return `${header}\n${divider}\n${rows.join('\n')}`;
}

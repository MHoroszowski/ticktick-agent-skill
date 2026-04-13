/**
 * commands/sections.ts — list sections (kanban columns) of a project.
 *
 * Hits /api/v2/column?from=0&projectId=X via the adapter. The underlying
 * library has two bugs (wrapped response + ignored projectId filter) that
 * the adapter works around — see `adapter.listSections` for details.
 */

import { createAdapter, parseCommandArgs, requireFlag } from '../cli.ts';
import { AdapterError } from '../adapter.ts';
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

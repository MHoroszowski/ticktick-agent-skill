/**
 * commands/projects.ts — project list and get.
 */

import { createAdapter, parseCommandArgs, requireFlag } from '../cli.ts';
import { AdapterError } from '../adapter.ts';
import { writeOk, writeHuman, formatProjectsTable } from '../output.ts';
import type { GlobalOpts } from '../cli.ts';

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

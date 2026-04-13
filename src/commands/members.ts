/**
 * commands/members.ts — list members of a shared project.
 *
 * Hits the /api/v2/project/{id}/users endpoint (discovered by probing in
 * April 2026; jaeyeonling/ticktick-client doesn't yet expose it). Also
 * upserts every member into the users cache so subsequent --assignee
 * lookups by name work.
 */

import { createAdapter, parseCommandArgs, requireFlag } from '../cli.ts';
import { AdapterError } from '../adapter.ts';
import { UsageError } from '../errors.ts';
import { writeOk, writeHuman } from '../output.ts';
import { rememberMembers, resolveUser } from '../users.ts';
import type { GlobalOpts } from '../cli.ts';
import type { Member, TickTickAdapter } from '../adapter.ts';

export async function list(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const projectArg = requireFlag(flags, 'project', 'project id or name');

  const adapter = createAdapter();
  const projectId = await resolveProjectId(adapter, projectArg);

  const members = await adapter.listMembers(projectId);
  rememberMembers(members);

  if (opts.human) {
    writeHuman(formatMembersTable(members));
    return;
  }
  writeOk({ count: members.length, projectId, members });
}

export async function remove(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const projectArg = requireFlag(flags, 'project', 'project id or name');
  const userArg = requireFlag(flags, 'user', 'user id, display name, or "me"');
  const force = flags['force'] === 'true' || flags['yes'] === 'true';

  const adapter = createAdapter();
  const projectId = await resolveProjectId(adapter, projectArg);

  // Populate the users cache from the current member list so `--user Cris`
  // style lookups resolve, AND so we can show the member's pre-removal
  // details in the confirmation prompt.
  const members = await adapter.listMembers(projectId);
  rememberMembers(members);

  const userId = resolveUser(userArg);
  if (userId === null) {
    throw new UsageError(
      '`members remove` requires a concrete user — "unassign"/"none" is not meaningful here.',
    );
  }

  const target = members.find((m) => m.userId === userId);
  if (target?.isOwner) {
    throw new UsageError(
      `Refusing to remove userId ${userId} — they are the project owner. TickTick's API silently ignores owner removal, so this would fail silently.`,
    );
  }

  if (!force) {
    const label = target
      ? `${target.displayName ?? target.username ?? '(unknown)'} [${userId}]`
      : `userId ${userId} (not currently a member — this will be a no-op)`;
    process.stderr.write(
      `About to remove ${label} from project ${projectId}.\n` +
        `Re-run with --force to execute. Aborting.\n`,
    );
    throw new UsageError('Confirmation required: pass --force to actually remove the member.');
  }

  await adapter.removeMember(projectId, userId);

  // Verify by diffing the member list. The endpoint is idempotent so a
  // no-op returns success; we need the diff to know if anything actually
  // changed.
  const after = await adapter.listMembers(projectId);
  rememberMembers(after);
  const stillPresent = after.some((m) => m.userId === userId);

  if (opts.human) {
    if (stillPresent) {
      writeHuman(
        `Warning: userId ${userId} is still listed as a member of ${projectId} after the DELETE. ` +
          `TickTick's remove endpoint is idempotent and returns 2xx even for no-ops; this likely ` +
          `means the request didn't match any real share record.`,
      );
      return;
    }
    writeHuman(`Removed userId ${userId} from project ${projectId}. Members remaining: ${after.length}.`);
    return;
  }
  writeOk({
    projectId,
    removedUserId: userId,
    stillPresent,
    remainingCount: after.length,
  });
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

function formatMembersTable(members: readonly Member[]): string {
  if (members.length === 0) return '(no members — this project is not shared)';
  const header = `${'USER ID'.padEnd(11)} ${'DISPLAY'.padEnd(24)} ${'PERMISSION'.padEnd(12)} ${'OWNER'.padEnd(5)} ACCEPTED`;
  const divider = '─'.repeat(Math.min(80, header.length));
  const rows = members.map((m) => {
    const uid = String(m.userId).padEnd(11);
    const name = (m.displayName ?? m.username ?? '(unknown)').slice(0, 23).padEnd(24);
    const perm = m.permission.padEnd(12);
    const owner = (m.isOwner ? 'yes' : 'no').padEnd(5);
    const accepted = m.acceptedShare ? 'yes' : 'pending';
    return `${uid} ${name} ${perm} ${owner} ${accepted}`;
  });
  return `${header}\n${divider}\n${rows.join('\n')}`;
}

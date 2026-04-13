/**
 * commands/tags.ts — tag list + CRUD (create / update / delete / rename / merge).
 */

import { createAdapter, parseCommandArgs, requireFlag } from '../cli.ts';
import { writeOk, writeHuman, formatTagsTable } from '../output.ts';
import { UsageError } from '../errors.ts';
import type { GlobalOpts } from '../cli.ts';
import type { TagDraft } from '../adapter.ts';

export async function list(_argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const adapter = createAdapter();
  const tags = await adapter.listTags();

  if (opts.human) {
    writeHuman(formatTagsTable(tags));
    return;
  }
  writeOk({ count: tags.length, tags });
}

export async function create(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const name = requireFlag(flags, 'name', 'tag slug (lowercase)');
  validateTagName(name);

  const draft: TagDraft = {
    name,
    ...(flags.label !== undefined && { label: flags.label }),
    ...(flags.color !== undefined && { color: flags.color }),
    ...(flags.parent !== undefined && { parent: flags.parent }),
  };

  const adapter = createAdapter();
  await adapter.createTag(draft);

  if (opts.human) {
    writeHuman(`Created tag '${name}'`);
    return;
  }
  writeOk({ tag: draft });
}

export async function update(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const name = requireFlag(flags, 'name', 'tag slug (lowercase)');
  validateTagName(name);

  if (
    flags.label === undefined &&
    flags.color === undefined &&
    flags.parent === undefined
  ) {
    throw new UsageError(
      'tags update needs at least one of --label, --color, --parent to change.',
    );
  }

  const draft: TagDraft = {
    name,
    ...(flags.label !== undefined && { label: flags.label }),
    ...(flags.color !== undefined && { color: flags.color }),
    ...(flags.parent !== undefined && { parent: flags.parent }),
  };

  const adapter = createAdapter();
  await adapter.updateTag(draft);

  if (opts.human) {
    writeHuman(`Updated tag '${name}'`);
    return;
  }
  writeOk({ tag: draft });
}

export async function remove(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const name = requireFlag(flags, 'name', 'tag slug to delete');
  const adapter = createAdapter();
  await adapter.deleteTag(name);

  if (opts.human) {
    writeHuman(`Deleted tag '${name}'`);
    return;
  }
  writeOk({ deleted: name });
}

export async function rename(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const name = requireFlag(flags, 'name', 'current tag slug');
  const to = requireFlag(flags, 'to', 'new display label (slug-style: lowercase, no whitespace)');
  validateTagName(to);

  const adapter = createAdapter();
  await adapter.renameTag(name, to);

  if (opts.human) {
    writeHuman(
      `⚠️  tags rename is BROKEN upstream — the API call returned ok but the tag ` +
        `was NOT actually renamed. The library posts to /api/v2/batch/tag with ` +
        `{name, label} and TickTick's server silently drops the update. See ` +
        `README.md "Known quirks" for the manual workaround.`,
    );
    return;
  }
  writeOk({
    name,
    requestedLabel: to,
    persisted: false,
    warning:
      'BROKEN: This call completes without error BUT the label is NOT actually ' +
      'updated on TickTick. Verified empirically on 2026-04-13 — the v2 /batch/tag ' +
      'endpoint silently drops label mutations. Use the manual workaround: ' +
      '(1) tags create --name <new>, (2) tasks update --tags <new> for each ' +
      'affected task, (3) tags delete --name ' + `'${name}'. See README.md "Known quirks".`,
  });
}

export async function merge(argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const { flags } = parseCommandArgs(argv);
  const from = requireFlag(flags, 'from', 'source tag slug (will be removed)');
  const to = requireFlag(flags, 'to', 'destination tag slug (receives the tasks)');
  if (from === to) {
    throw new UsageError(`--from and --to must differ; got '${from}' twice.`);
  }

  const adapter = createAdapter();
  await adapter.mergeTags(from, to);

  if (opts.human) {
    writeHuman(`Merged tag '${from}' → '${to}'`);
    return;
  }
  writeOk({ from, to });
}

// ──────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────

function validateTagName(name: string): void {
  // TickTick rejects whitespace and uppercase in tag slugs. The label
  // (display name) can be anything; the name (slug) cannot.
  if (name.length === 0) {
    throw new UsageError('tag name cannot be empty');
  }
  if (/\s/.test(name)) {
    throw new UsageError(`tag name cannot contain whitespace: '${name}'`);
  }
  if (name !== name.toLowerCase()) {
    throw new UsageError(`tag name must be lowercase: '${name}'`);
  }
}

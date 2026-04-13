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
  const to = requireFlag(flags, 'to', 'new tag slug or label');
  validateTagName(to);

  const adapter = createAdapter();
  await adapter.renameTag(name, to);

  if (opts.human) {
    writeHuman(`Renamed tag '${name}' → '${to}'`);
    return;
  }
  writeOk({ from: name, to });
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

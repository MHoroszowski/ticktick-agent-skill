/**
 * commands/tags.ts — tag list.
 */

import { createAdapter } from '../cli.ts';
import { writeOk, writeHuman } from '../output.ts';
import type { GlobalOpts } from '../cli.ts';

export async function list(_argv: readonly string[], opts: GlobalOpts): Promise<void> {
  const adapter = createAdapter();
  const tags = await adapter.listTags();

  if (opts.human) {
    if (tags.length === 0) {
      writeHuman('(no tags)');
      return;
    }
    const lines = tags.map((t) => `${t.name}${t.label ? `\t${t.label}` : ''}`);
    writeHuman(lines.join('\n'));
    return;
  }
  writeOk({ count: tags.length, tags });
}

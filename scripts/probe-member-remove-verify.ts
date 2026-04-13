/**
 * Third-stage verification: confirm that the DELETE probes in probe-member-
 * remove-confirm.ts did NOT actually remove the owner or the valid partner
 * member from the Shopping project. Lists the members and prints the count.
 *
 * Expected: 3 members (Matthew owner, Cris, Doma).
 */

import { TickTickClient, FileSessionStore } from 'ticktick-client';
import { loadCredentials } from '../src/env.ts';
import { resolveSessionPath, sanitizeSessionFile } from '../src/session.ts';

sanitizeSessionFile();
const creds = loadCredentials();
if (!creds) throw new Error('no creds in env');

const client = new TickTickClient({
  credentials: { username: creds.email, password: creds.password },
  sessionStore: new FileSessionStore(resolveSessionPath()),
});
await client.login();

const raw = client as unknown as {
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
};

const PID = '6852d2ff8f0867dce3d54ff5';

const members = await raw.request<ReadonlyArray<Record<string, unknown>>>(
  'GET',
  `/api/v2/project/${PID}/users`,
);

console.log(`members count: ${members.length}`);
for (const m of members) {
  console.log(
    `  userId=${m['userId']} display=${m['displayName'] ?? m['username'] ?? '?'} isOwner=${m['isOwner'] ?? false}`,
  );
}

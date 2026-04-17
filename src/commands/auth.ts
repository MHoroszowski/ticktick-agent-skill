/**
 * commands/auth.ts — login, logout, whoami.
 */

import { createAdapter } from '../cli.ts';
import { clearSession, getSessionAgeSeconds } from '../session.ts';
import { writeOk } from '../output.ts';
import { rememberSelf } from '../users.ts';
import { getAccount } from '../context.ts';
import type { GlobalOpts } from '../cli.ts';

export async function login(_argv: readonly string[], _opts: GlobalOpts): Promise<void> {
  // login is idempotent — it always forces a fresh session. The adapter's
  // authenticate() calls client.login() unconditionally.
  const adapter = createAdapter();
  const user = await adapter.authenticate();
  // Cache self so --assignee me works on subsequent commands.
  // authenticate() already calls getUser() internally, which hits both
  // /user/profile and /user/status to get the numeric userId.
  const withId = await adapter.getUser();
  rememberSelf(withId);
  writeOk({ account: getAccount(), user: withId, sessionAgeSec: 0 });
}

export async function logout(_argv: readonly string[], _opts: GlobalOpts): Promise<void> {
  // Use the adapter's logout for correctness (it resets internal state),
  // then also clearSession() as a belt-and-suspenders step in case the
  // library's FileSessionStore.delete leaves the file behind.
  try {
    const adapter = createAdapter();
    await adapter.logout();
  } catch {
    // Even if we couldn't construct the adapter (no creds), we can still
    // delete the local session file. logout should succeed either way.
  }
  clearSession();
  writeOk({ account: getAccount() });
}

export async function whoami(_argv: readonly string[], _opts: GlobalOpts): Promise<void> {
  const adapter = createAdapter();
  const user = await adapter.getUser();
  rememberSelf(user);
  const age = getSessionAgeSeconds();
  writeOk({ account: getAccount(), user, sessionAgeSec: age ?? 0 });
}

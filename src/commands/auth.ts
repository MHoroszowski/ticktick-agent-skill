/**
 * commands/auth.ts — login, logout, whoami.
 */

import { createAdapter } from '../cli.ts';
import { clearSession, getSessionAgeSeconds } from '../session.ts';
import { writeOk } from '../output.ts';
import type { GlobalOpts } from '../cli.ts';

export async function login(_argv: readonly string[], _opts: GlobalOpts): Promise<void> {
  // login is idempotent — it always forces a fresh session. The adapter's
  // authenticate() calls client.login() unconditionally.
  const adapter = createAdapter();
  const user = await adapter.authenticate();
  writeOk({ user, sessionAgeSec: 0 });
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
  writeOk({});
}

export async function whoami(_argv: readonly string[], _opts: GlobalOpts): Promise<void> {
  const adapter = createAdapter();
  const user = await adapter.getUser();
  const age = getSessionAgeSeconds();
  writeOk({ user, sessionAgeSec: age ?? 0 });
}

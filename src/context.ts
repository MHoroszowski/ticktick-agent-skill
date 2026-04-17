/**
 * context.ts — process-wide CLI context, set once by the dispatcher.
 *
 * Currently carries only the active account ('live' | 'test'). env.ts,
 * session.ts, and users.ts all read from here rather than accepting an
 * account parameter on every function, which would force every call site
 * to thread it through. The CLI has a single entry point (cli.ts::main),
 * so a module-level variable is safe here.
 *
 * Why: the test account is a dedicated TickTick service account used for
 * PAI-skill smoke tests and exploratory probes. Isolating test traffic
 * from the live account prevents race conditions between agent writes
 * and the user's manual web/mobile UI interactions.
 */

export type Account = 'live' | 'test';

let currentAccount: Account = 'live';

export function setAccount(account: Account): void {
  currentAccount = account;
}

export function getAccount(): Account {
  return currentAccount;
}

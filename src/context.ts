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
 * smoke tests and exploratory probes. It exists for two reasons, and both
 * matter — the smoke suite is NOT confined to a scratch project (it
 * mutates account-global tags, creates and deletes projects, and touches
 * a real shared list), so running it against the live account would hit
 * real data; and isolating test traffic prevents race conditions between
 * agent writes and the user's manual web/mobile UI interactions.
 */

export type Account = 'live' | 'test';

let currentAccount: Account = 'live';

export function setAccount(account: Account): void {
  currentAccount = account;
}

export function getAccount(): Account {
  return currentAccount;
}

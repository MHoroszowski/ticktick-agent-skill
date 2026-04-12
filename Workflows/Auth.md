# Workflow: Auth

**Intent:** User is asking about session state — "am I logged into TickTick," "log me in," "logout," "refresh my TickTick session."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the Auth workflow in the TickTick skill to manage the session"}' \
  > /dev/null 2>&1 &
```

## Commands

**Check current session:**
```bash
~/.claude/skills/TickTick/bin/ticktick whoami
```
Returns `{ok: true, user, sessionAgeSec}` on success. `sessionAgeSec` is how long the session file has been on disk.

**Force a fresh login:**
```bash
~/.claude/skills/TickTick/bin/ticktick login
```
Idempotent — always re-logs-in and rewrites the session file. Credentials come from `~/.env` (`TICKTICK_EMAIL`, `TICKTICK_PASSWORD`).

**Logout:**
```bash
~/.claude/skills/TickTick/bin/ticktick logout
```
Deletes the local session file. The TickTick server-side session also gets invalidated.

## Presentation

On `whoami` success:
> "Logged into TickTick as [email]. Session is [age] old."

On `login` success:
> "Logged in to TickTick as [email]."

On `logout` success:
> "Logged out of TickTick. Your session file has been deleted."

## Errors

- `AUTH_MISSING_CREDS` → "No TickTick credentials are set. Add `TICKTICK_EMAIL` and `TICKTICK_PASSWORD` to `~/.env` and try again."
- `AUTH_FAILED` → "TickTick rejected those credentials. Double-check the password. If you recently changed it, update `~/.env`."
- `AUTH_EXPIRED` on `whoami` is unusual — the CLI auto-refreshes on expiry. If you see it, something else is wrong; surface `.error.message` verbatim and suggest running `login`.

## Note about 2FA

The unofficial v2 API this skill depends on does not support TickTick 2FA accounts. If the user has 2FA enabled, login will fail. They'll need to either disable 2FA on the account or use a dedicated account without it.

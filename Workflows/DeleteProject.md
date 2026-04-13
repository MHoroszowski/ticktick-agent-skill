# Workflow: DeleteProject

**Intent:** User wants to delete a list — "delete the X list," "remove my X project," "get rid of the X list."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the DeleteProject workflow in the TickTick skill to delete a project"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **id** — the project id or name

## Execute — two-step safety gate

**Step 1: dry-run (NO `--confirm`) to see what would be destroyed.**

```bash
~/.claude/skills/TickTick/bin/ticktick projects delete --id "Home renovation"
```

This call is designed to fail with exit code 6 and a `VALIDATION` error containing the task count:
> `Refusing to delete project 68xxxx: it contains 14 tasks which will be permanently destroyed. Re-run with --confirm to proceed.`

Parse the `.error.message` to extract the task count.

**Step 2: confirm with the user, then re-run with `--confirm`.**

Show the user the task count and get explicit approval:
> "Deleting the 'Home renovation' list will also permanently delete 14 tasks inside it. This is hard to recover. Are you sure?"

Only after explicit yes:
```bash
~/.claude/skills/TickTick/bin/ticktick projects delete --id "Home renovation" --confirm
```

## Presentation

On success:
> "Deleted the 'Home renovation' list and its 14 tasks."

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `VALIDATION` on the first (dry-run) call is **expected** — it's the safety gate. Parse the count and proceed to the confirm step.
- `VALIDATION` on the `--confirm` call is unexpected → surface `.error.message` verbatim.
- `NOT_FOUND` → "I couldn't find a list matching '[X]'. Run `ticktick projects list`."
- Any other code → surface `.error.message` verbatim.

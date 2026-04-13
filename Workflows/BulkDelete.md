# Workflow: BulkDelete

**Intent:** User wants to delete multiple tasks at once — "delete all these tasks," "clear the whole morning routine list," "remove everything I listed."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the BulkDelete workflow in the TickTick skill to delete multiple tasks"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **task ids** — a list. Resolve from prior context and **always** confirm with the user before executing. Deleted tasks go to the TickTick trash but cannot be reliably listed or restored through the skill (trash listing is broken upstream).

Optional:
- **project** — if every task is in the same project, pass `--project <id>` once to skip per-task resolve round-trips

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tasks delete-many --ids 7a5f1b2c,92ae3d4f,01cd9e6a
```

With shared project shortcut:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks delete-many --ids 7a5f1b2c,92ae3d4f --project "Work"
```

## Presentation

**Always confirm before deleting.** Show the user the exact titles and ids:
> "I'm about to delete 3 tasks: 'Call mom,' 'Update quarterly review,' 'Replace HVAC filter.' These will be hard to recover. Proceed?"

Only run the CLI after explicit confirmation.

On success:
> "Deleted 3 tasks."

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `NOT_FOUND` → "I couldn't find task id [X]. Stopped — re-confirm the ids." Note that if the error happens mid-batch some tasks may already be deleted.
- Any other code → surface `.error.message` verbatim.

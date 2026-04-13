# Workflow: BulkComplete

**Intent:** User wants to mark multiple tasks done at once — "complete all of these," "mark these done," "I finished everything in the morning routine list."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the BulkComplete workflow in the TickTick skill to complete multiple tasks"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **task ids** — a list. Resolve from prior context (the tasks the user most recently listed or referenced) and confirm with the user before executing, since this is destructive-ish.

Optional:
- **project** — if every task is in the same project, pass `--project <id>` once to skip per-task resolve round-trips (faster for large batches)

## Execute

Comma-separated ids:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks complete-many --ids 7a5f1b2c,92ae3d4f,01cd9e6a
```

With shared project shortcut:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks complete-many --ids 7a5f1b2c,92ae3d4f --project "Work"
```

## Presentation

Before executing, always show the user the list of tasks you're about to complete and get explicit confirmation ("I'm about to mark 3 tasks done — the three you just listed. OK to proceed?").

On success, confirm briefly:
> "Marked 3 tasks done: 'Call mom,' 'Update quarterly review,' 'Replace HVAC filter.'"

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `NOT_FOUND` → "I couldn't find task id [X]. Stopped before completing anything — re-confirm the ids and try again." Batch is NOT transactional in TickTick; if the error happens mid-batch, some tasks may already be completed. Mention this.
- Any other code → surface `.error.message` verbatim.

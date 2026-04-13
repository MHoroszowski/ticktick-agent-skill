# Workflow: UnpinTask

**Intent:** User wants to unpin a task — "unpin X," "unpin task X," "X doesn't need to stay at the top anymore."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the UnpinTask workflow in the TickTick skill to unpin a task"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **task id** — resolve from prior context (most recent task list) or ask the user which task

Optional:
- **project** — pass `--project <id>` to skip the auto-resolve round-trip

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tasks unpin --id 7a5f1b2c...
```

## Presentation

On success, confirm briefly:
> "Unpinned 'Quarterly review prep' — it's back in its normal position."

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `NOT_FOUND` → "I couldn't find that task. Run `ticktick tasks list` to see available ids."
- Any other code → surface `.error.message` verbatim.

# Workflow: PinTask

**Intent:** User wants to pin a task to the top of its list — "pin X," "pin task X to the top," "keep X at the top of my list."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the PinTask workflow in the TickTick skill to pin a task"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **task id** — resolve from prior context (most recent task list) or ask the user which task

Optional:
- **project** — if the user already has the task's project id handy, pass `--project <id>` to skip the auto-resolve round-trip

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tasks pin --id 7a5f1b2c...
```

With explicit project id:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks pin --id 7a5f1b2c... --project 68...
```

## Presentation

On success, confirm briefly:
> "Pinned 'Quarterly review prep' to the top of your Work list."

If the user pinned something already visible in the current task list presentation, include the new order ("now shows as the first task").

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `NOT_FOUND` → "I couldn't find that task. Run `ticktick tasks list` to see available ids." (pin is idempotent-ish but the task id must exist)
- Any other code → surface `.error.message` verbatim.

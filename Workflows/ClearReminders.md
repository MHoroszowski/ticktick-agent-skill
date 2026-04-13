# Workflow: ClearReminders

**Intent:** User wants to remove ALL reminders from a task — "clear all reminders on X," "stop reminding me about Y," "drop every reminder from Z."

This is a destructive operation on the task's `reminders[]` array. The task itself and its due date are NOT touched — only the reminder list is emptied.

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the ClearReminders workflow in the TickTick skill to clear all reminders"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **task** — the target task. Resolve to an id via `tasks get` or `tasks list` if you don't already have one.

Optional:
- **project / list** — only if you need to disambiguate.

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tasks remind clear --id <task-id>
```

With explicit project:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks remind clear \
  --id <task-id> \
  --project "Work"
```

## Presentation

On success, report how many were cleared:
> "Cleared 3 reminders from 'Quarterly review prep'. The task itself is still there and due Friday at 5."

If the task had no reminders, the CLI still returns `ok: true` with `previousReminders: []` — report honestly:
> "There were no reminders on that task to clear."

## Errors

- `NOT_FOUND` on task id → offer to list tasks.
- Auth errors → see `Auth.md`.

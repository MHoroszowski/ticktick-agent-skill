# Workflow: RemoveReminder

**Intent:** User wants to remove a specific reminder from a task while keeping the rest — "drop the 15-minute reminder on X," "remove the 1-day reminder from Y," "take off the hour-before ping on Z."

This workflow removes ONE matching reminder by offset. To remove ALL reminders from a task in one shot, use `ClearReminders.md`.

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the RemoveReminder workflow in the TickTick skill to remove a reminder"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **task** — the target task. Resolve to an id via `tasks get` or `tasks list` if needed.
- **offset** — which reminder to remove. Same format as `AddReminder.md`:
  - `15m`, `1h`, `1d`, `1d9h`, `at-start`, or raw `TRIGGER:...`

The offset must match the exact form stored on the task. If the user says "the 15-minute one," use `15m`. If the task has `15m` and `30m`, "the 15-minute one" unambiguously maps to `15m`. If ambiguity is possible, run `tasks get --id <id>` first and list the current reminders to the user.

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tasks remind remove \
  --id <task-id> \
  --offset 15m
```

## Presentation

On success, show the remaining reminders:
> "Removed the 15-minute reminder. Still active: [1d]."

If the task had nothing matching that offset, the CLI reports it as a no-op — pass that through:
> "There was no 15-minute reminder on that task. Current reminders: [1d, 1h]."

## Errors

- `USAGE` on offset parser → quote the hint verbatim.
- `NOT_FOUND` on task id → offer to list tasks.
- Auth errors → see `Auth.md`.

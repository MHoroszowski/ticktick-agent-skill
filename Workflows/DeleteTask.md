# Workflow: DeleteTask

**Intent:** User wants to permanently remove a task — "delete X," "remove Y," "get rid of Z."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the DeleteTask workflow in the TickTick skill to delete a task"}' \
  > /dev/null 2>&1 &
```

## Confirm before deleting

**Deletion is destructive.** Before running the command, confirm the target with the user by stating the full task title and asking:
> "I'll delete 'Quarterly review prep' from your Work list. Confirm?"

If the user's original utterance was anything ambiguous ("delete that one" vs a specific named task), you MUST resolve + confirm before proceeding. Do NOT delete on vague references.

## Resolve the task id

If the user named the task by title (not id), list open tasks and fuzzy-match:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks list --status open
```
If 0 matches, check completed: `--status completed`. If 2+ matches, show the list and ask.

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tasks delete --id <taskId>
```

(The CLI fetches projectId automatically if you don't pass `--project`.)

## Presentation

On success:
> "Deleted 'Quarterly review prep'."

## Errors

- `AUTH_*` → as in `ListTasks.md`.
- `NOT_FOUND` → "I couldn't find a task with that id — it may already be deleted."

## Caveat about recovery

TickTick's v2 API does **not** reliably expose the trash for listing. If the user asks to restore a task they just deleted, you can only attempt `restore` if they can provide the exact task id AND you saved it before deletion. Otherwise, tell them they'll need to restore from the TickTick web UI directly.

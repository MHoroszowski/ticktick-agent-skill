# Workflow: MoveTask

**Intent:** User wants to move a task between lists — "move X to Work," "put Y in the Inbox," "reassign Z to the Personal list."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the MoveTask workflow in the TickTick skill to move a task between lists"}' \
  > /dev/null 2>&1 &
```

## ⚠️ Important: moves change the task id

TickTick's v2 REST API does not support in-place project moves. The CLI implements a move as **copy-to-destination + delete-from-source**. This means the task gets a **new id** after the move. The CLI surfaces both ids in the response:

```json
{"ok": true, "task": {"id": "<newId>", ...}, "previousId": "<oldId>", "note": "..."}
```

If you're about to act on the task right after moving it (e.g. to mark it done), use the NEW id from `.task.id`, not the old one.

## Resolve ids

If the user named the task by title, list and fuzzy-match:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks list --status open
```

You can pass the destination list by name or id — the CLI resolves names automatically.

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tasks move \
  --id <taskId> \
  --to "Work"
```

(The CLI fetches the source projectId automatically if you don't pass `--from`.)

## Presentation

On success:
> "Moved 'Quarterly review prep' from Inbox to Work. (New id: 7a5f1b2c, was 01cd9e6a.)"

Don't bury the id change — if the user is chaining operations, they need to know.

## Errors

- `AUTH_*` → as in `ListTasks.md`.
- `NOT_FOUND` on the destination → **do not create the destination list** (see `SKILL.md` § Autonomy Boundary). Say: "I couldn't find a list named '[X]', and I won't create one unless you ask. Run `ticktick projects list` to see what's available." Creating it happens only on an express request (→ `Workflows/CreateProject.md`).
- `NOT_FOUND` on the task → "I couldn't find that task — was it maybe already moved or deleted?"

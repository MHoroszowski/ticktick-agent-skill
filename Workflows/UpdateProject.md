# Workflow: UpdateProject

**Intent:** User wants to modify a list's metadata — "rename my X list," "change the color of my X list to blue," "switch X to kanban view."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the UpdateProject workflow in the TickTick skill to update a project"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **id** — the project id OR name. The CLI accepts either.

At least ONE of:
- **name** — new display name
- **color** — new `#RRGGBB` hex
- **view** — `list`, `kanban`, or `timeline`
- **kind** — `task` or `note`

## Execute

Rename:
```bash
~/.claude/skills/TickTick/bin/ticktick projects update --id "Home renovation" --name "Home Reno 2026"
```

Recolor:
```bash
~/.claude/skills/TickTick/bin/ticktick projects update --id "Home Reno 2026" --color "#FF6D00"
```

Switch view:
```bash
~/.claude/skills/TickTick/bin/ticktick projects update --id "Home Reno 2026" --view kanban
```

## Presentation

On success, confirm briefly with exactly what changed:
> "Renamed 'Home renovation' to 'Home Reno 2026'."
> "Updated the color of 'Home Reno 2026' to orange."

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `USAGE` ("needs at least one of --name, --color, --view, --kind") → the user didn't say what to change; ask.
- `NOT_FOUND` → "I couldn't find a list matching '[X]'. Run `ticktick projects list`."
- Any other code → surface `.error.message` verbatim.

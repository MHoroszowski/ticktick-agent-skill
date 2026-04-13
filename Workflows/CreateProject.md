# Workflow: CreateProject

**Intent:** User wants a new list — "create a list," "new project X," "make a list called X," "add a list for X."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the CreateProject workflow in the TickTick skill to create a project"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **name** — the list name. Any casing/whitespace/emojis are allowed (TickTick stores these verbatim).

Optional:
- **color** — `#RRGGBB` hex. Parse color words ("green" → `#00C853`, etc.) before calling.
- **kind** — `task` (default) or `note`. Notes are markdown notebooks, not task lists. Use `note` only when the user explicitly says "notebook" or "notes."
- **view** — `list` (default), `kanban`, or `timeline`. Use `kanban` when the user says "board" or "kanban."

## Execute

Minimum:
```bash
~/.claude/skills/TickTick/bin/ticktick projects create --name "Home renovation"
```

Full:
```bash
~/.claude/skills/TickTick/bin/ticktick projects create \
  --name "Home renovation" \
  --color "#00C853" \
  --kind task \
  --view kanban
```

## Presentation

On success, confirm briefly:
> "Created the 'Home renovation' list (kanban view, green)."

Include the new project id from the response for follow-up commands the user might want to run.

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `USAGE` ("--kind must be one of..." / "--view must be one of...") → surface verbatim; retry with a valid value.
- `VALIDATION` (duplicate name, bad color) → surface `.error.message` verbatim.
- Any other code → surface `.error.message` verbatim.

# Workflow: RenameSection

**Intent:** User wants to rename an existing kanban section — "rename the 'Todo' section in Work to 'Backlog'," "change the 'Doing' column to 'In Progress'."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the RenameSection workflow in the TickTick skill to rename a section"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **project** — which project / list (`--project "Work"`)
- **section** — current section name or id (`--section "Todo"`)
- **to** — new section name (`--to "Backlog"`)

The CLI accepts the section by name (case-insensitive exact or unique prefix) or by 24-char hex id.

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick sections rename \
  --project "Work" \
  --section "Todo" \
  --to "Backlog"
```

## Presentation

On success, confirm briefly:
> "Renamed 'Todo' → 'Backlog' in your Work board."

## Errors

- `AUTH_*` → as in `ListTasks.md`.
- `NOT_FOUND` on the project → standard "list not found" message.
- `NOT_FOUND` on the section → "I couldn't find a section named '[X]' in [project]. Run `ticktick sections list --project [project]` to see what's there."
- `USAGE` (ambiguous section name) → list the candidates from the error message and ask the user which one they meant.

## Notes

The TickTick rename endpoint is a full-record REPLACE under the hood — the CLI fetches the current `sortOrder` first and re-sends it so the section keeps its place in the column order. You don't need to think about that, but it's why the rename takes one extra round-trip.

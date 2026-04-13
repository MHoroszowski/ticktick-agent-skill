# Workflow: CreateSection

**Intent:** User wants to add a new kanban section (column) to a project — "create a section called X in my Work list," "add a kanban column 'In Review' to the Project X board," "add an Inbox column to my Shopping list."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the CreateSection workflow in the TickTick skill to add a new section"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **project** — which project / list to add the section to (`--project "Work"` or by id)
- **name** — the section name (`--name "In Review"`)

Optional:
- **placement** — "before X," "after Y." If the user says "at the end" (the default), omit both flags. Pass exactly one of:
  - `--after <id|name>` — place immediately after this section
  - `--before <id|name>` — place immediately before this section

If neither `--after` nor `--before` is supplied, the new section goes at the end of the column list.

## Execute

Minimum:
```bash
~/.claude/skills/TickTick/bin/ticktick sections create \
  --project "Work" \
  --name "In Review"
```

With placement:
```bash
~/.claude/skills/TickTick/bin/ticktick sections create \
  --project "Work" \
  --name "Blocked" \
  --after "In Progress"
```

## Presentation

On success, confirm briefly and surface the new id:
> "Added the 'In Review' section to your Work board (id: 7a5f1b2c…)."

If you used `--after` / `--before`, mention the placement so the user knows it landed where they asked.

## Errors

- `AUTH_*` → as in `ListTasks.md`.
- `NOT_FOUND` on project → "I couldn't find a list named '[X]'. Run `ticktick projects list` to see what's available."
- `NOT_FOUND` on the `--after` / `--before` anchor → "I couldn't find a section named '[Y]' in [project]. Run `ticktick sections list --project [project]` to see what's there."
- `USAGE` (both `--before` and `--after` passed) → tell the user to pick one.
- `NETWORK` mentioning `id2error` → TickTick rejected the create payload (e.g. duplicate id collision — extremely rare); retry once.

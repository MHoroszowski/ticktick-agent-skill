# Workflow: CreateTag

**Intent:** User wants to create a new tag — "create a tag," "add a new tag X," "make a tag called work with color blue."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the CreateTag workflow in the TickTick skill to create a tag"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **name** — the tag slug. MUST be lowercase and whitespace-free (TickTick enforces this). If the user says "Work Projects," convert to `work-projects` or `workprojects` and pass the original phrasing as `--label`.

Optional:
- **label** — display name. Defaults to `name` if omitted. Use when you had to slug-ify the name.
- **color** — `#RRGGBB` hex. Parse color words ("red" → `#FF0000`, "blue" → `#0066FF`, etc.) before calling.
- **parent** — parent tag name for hierarchical tags. The parent must already exist.

## Execute

Minimum:
```bash
~/.claude/skills/TickTick/bin/ticktick tags create --name work
```

Full:
```bash
~/.claude/skills/TickTick/bin/ticktick tags create \
  --name work-projects \
  --label "Work Projects" \
  --color "#0066FF" \
  --parent work
```

## Presentation

On success, confirm briefly:
> "Created tag 'Work Projects' (slug: work-projects, blue)."

If the user gave a multi-word name that you slug-ified, tell them what slug you used so they can reference it later.

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `USAGE` with "must be lowercase" or "cannot contain whitespace" → slug-ify the name and retry.
- `VALIDATION` → surface `.error.message` verbatim (usually a bad color format or duplicate name).
- Any other code → surface `.error.message` verbatim.

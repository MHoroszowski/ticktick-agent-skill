# Workflow: CreateTask

**Intent:** User wants to add a task — "add a task to X," "remind me to Y," "create a todo for Z," "put X on my list."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the CreateTask workflow in the TickTick skill to create a task"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **title** — the main text of the task

Optional (extract if mentioned):
- **project / list** — "add to my Work list" → `--project "Work"`
- **due date** — parse natural language into ISO 8601 BEFORE calling (e.g. "tomorrow at 3pm" → `2026-04-13T15:00:00.000+0000`). The CLI does NOT parse natural language — you must do it.
- **priority** — none, low, medium, high
- **content** — markdown body if the user provided a description
- **tags** — comma-separated, e.g. `--tags work,urgent`

## Guardrails — read `SKILL.md` § Autonomy Boundary

This workflow is bound by the **Autonomy Boundary** in `SKILL.md`. In particular, on a task create:

- **Tags:** only pass `--tags` for tags that already exist (verify with `ticktick tags list`). Passing a new tag string auto-creates it server-side — don't. If the user named a tag that doesn't exist, surface it and ask; never invent one.
- **Lists:** never create a list. If the named project doesn't exist, see the `NOT_FOUND` handling below — do not create it.
- **Reminders / alarms:** do NOT add `--remind` (or any alarm/alert) unless the user expressly asked to be reminded. A due date is not a reminder request.
- **Sections:** don't pass a `--section` that doesn't exist on the target list — omit it and mention there's no such section.
- **Allowed freely:** `--due` and `--priority` whenever the user specified them — these are not gated.

## Execute

Minimum:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks create --title "Call mom"
```

Full:
```bash
~/.claude/skills/TickTick/bin/ticktick tasks create \
  --title "Quarterly review prep" \
  --project "Work" \
  --due "2026-04-15T17:00:00.000+0000" \
  --priority high \
  --tags work,review \
  --content "Pull the latest metrics from the dashboard before the Friday sync."
```

## Presentation

On success, confirm briefly:
> "Added 'Quarterly review prep' to your Work list, due Friday April 15 at 5:00 PM, high priority."

Include the task id from the response in case the user wants to act on it next.

If the user didn't specify a project, the task lands in their default Inbox — make that clear:
> "Added 'Call mom' to your Inbox."

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `NOT_FOUND` on the project → **do not create the list.** Say: "I couldn't find a list named '[X]', and I won't create a new list unless you ask me to. Want me to add this to your Inbox instead, or list your existing projects so you can pick one?" Creating the list happens only if the user then expressly asks (→ `Workflows/CreateProject.md`).
- `VALIDATION` → pass the message through — usually a malformed date or bad priority value.

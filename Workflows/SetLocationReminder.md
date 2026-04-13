# Workflow: SetLocationReminder

**Intent:** User wants a geofence-based reminder on a task — "remind me when I arrive at the grocery store," "ping me when I leave the office about X," "pick up the dry cleaning next time I'm near home."

This workflow attaches (or replaces) the geofence on a task. Each task can hold ONE location. Set/replace via `tasks create`/`tasks update` with the `--location-*` flags. Clear via the dedicated `tasks location clear` subcommand — passing `--location-*` flags can only set, not clear.

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the SetLocationReminder workflow in the TickTick skill to attach a geofence"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **task** — new or existing task. If the user describes it fresh, create a new one. If they reference an existing task by description, resolve to a task id via `tasks list` first.
- **lat / lng** — geographic coordinates. If the user gives an address ("123 Market St") or a place name ("home", "the gym", "the dry cleaner on 4th"), resolve to coordinates BEFORE invoking the CLI. The skill does not geocode. Ask the user for clarification if the place name is ambiguous — don't guess landmarks.
- **trigger** — `arrive` (default if unspecified) or `leave`. "Remind me when I get there" → arrive. "Remind me when I leave" → leave.

Optional:
- **radius** — meters. Default 100. Bigger radius = fires earlier (arrive) or later (leave); smaller radius = tighter zone but more susceptible to GPS jitter.
  - 50m: tight, indoor-precise
  - 100m: balanced default for most "at a place" scenarios
  - 200m: lenient, fires from across the parking lot
- **alias** — friendly label for the location ("Home", "Work", "Dry Cleaner"). Shown in TickTick's UI and in the skill's `--human` table.
- **address** — full street address. Display only; doesn't affect when the geofence fires.

## Execute

### Set on a new task

```bash
~/.claude/skills/TickTick/bin/ticktick tasks create \
  --title "pick up dry cleaning" --project "Errands" \
  --due "<ISO 8601 due date>" \
  --location-lat 37.7749 --location-lng -122.4194 \
  --location-radius 100 --location-trigger arrive \
  --location-alias "Dry Cleaner" \
  --location-address "456 Main St, San Francisco, CA"
```

### Attach to an existing task

```bash
~/.claude/skills/TickTick/bin/ticktick tasks update \
  --id <task-id> --project <project-id-or-name> \
  --title "<existing title — required by tasks update>" \
  --location-lat 37.7749 --location-lng -122.4194 \
  --location-radius 100 --location-trigger arrive \
  --location-alias "Home"
```

Note: `tasks update` requires `--title` even if you're not changing it. Pass the existing title verbatim. Other flags (`--due`, `--priority`, etc.) are optional and will be preserved if omitted — the adapter hydrates the full task body before sending the update so geofence-only updates don't wipe other fields.

### Clear

```bash
~/.claude/skills/TickTick/bin/ticktick tasks location clear \
  --id <task-id> [--project <pid>]
```

The clear path uses a batch-endpoint escape hatch (the patch endpoint silently no-ops every "clear" shape we tried). The CLI returns the cleared task plus the `previousLocation` for confirmation.

## Presentation

On success, confirm the geofence in plain language:

> "Set up a 100-meter arrive-geofence on 'pick up dry cleaning' at the Dry Cleaner. Your phone should fire the notification within seconds of entering the radius."

For an updated geofence, mention what changed:

> "Updated the geofence on 'pick up dry cleaning' — now a 200-meter leave-trigger. It'll fire when you leave the area instead of when you arrive."

For a cleared geofence:

> "Removed the location reminder from 'pick up dry cleaning'."

iPhone push delivery for API-set geofences was verified end-to-end during PLAN_05 mobile QA on 2026-04-13 — geofences fire within seconds of crossing the radius. Don't add disclaimers about whether mobile reminders actually work; they do.

## Errors

- `USAGE` on missing `--location-lat`/`--location-lng` pairing → surface the error message verbatim. Both flags are required as a pair; passing one alone is rejected before any network call.
- `USAGE` on out-of-range coordinates → lat must be in [-90, 90], lng in [-180, 180]. Surface the message.
- `USAGE` on `--location-radius <= 0` or non-integer → surface the message.
- `USAGE` on `--location-trigger` other than `arrive`/`leave` → surface the message.
- `NOT_FOUND` on `tasks update` with an unknown task id → "I couldn't find that task. Want me to list your recent tasks so you can pick it?"
- Auth errors → see `Auth.md`.

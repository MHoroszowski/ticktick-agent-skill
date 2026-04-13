# Workflow: RenameTag

**Intent:** User wants to rename a tag in place — "rename tag X to Y," "change the X tag to Y."

## Voice notification (required before running the CLI)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the RenameTag workflow in the TickTick skill to rename a tag"}' \
  > /dev/null 2>&1 &
```

## Extract from the user's intent

Required:
- **name** — the current tag slug (lowercase, no whitespace)
- **to** — the new slug. Same lowercase/no-whitespace rules.

If the user provides a display label like "Work Projects," slug-ify to `work-projects` and pass the original as the label on a follow-up `tags update --label` call if you want the display text to match.

## Execute

```bash
~/.claude/skills/TickTick/bin/ticktick tags rename --name work --to career
```

## Presentation

On success, confirm briefly:
> "Renamed the 'work' tag to 'career'. Every task previously tagged 'work' is now tagged 'career'."

Note: rename reassigns the tag on every existing task automatically — it's slug-to-slug, not a delete-and-recreate.

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- `USAGE` with "must be lowercase" or "cannot contain whitespace" → slug-ify and retry.
- `NOT_FOUND` → "I couldn't find a tag named '[X]'. Run `ticktick tags list` first."
- Any other code → surface `.error.message` verbatim.

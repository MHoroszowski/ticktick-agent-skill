# Workflow: RenameTag

**Intent:** User wants to rename a tag — "rename tag X to Y," "change the X tag to Y."

## 🚨 DO NOT USE THIS CLI COMMAND DIRECTLY — IT IS KNOWN BROKEN

The `ticktick tags rename` CLI command is **fully broken upstream**. The underlying library's POST to `/api/v2/batch/tag` is silently dropped by TickTick's server — verified empirically 2026-04-13 across multiple body shapes including full-record replaces. The call returns `ok: true` (but now with `persisted: false` in the response and a `warning` field) while nothing actually changes on TickTick's side.

**This is a known rough edge shipped with v1.3.** See SKILL.md "Known quirks" and README.md for context.

## What to do instead — the manual workaround

Walk the user through a three-step re-tag-and-delete flow. This actually achieves what they wanted.

1. **Confirm scope.** Tell the user: "The `tags rename` command is broken upstream — I can't just change the tag name in place. The working alternative is to create a new tag with the new name, re-tag every task that had the old tag, then delete the old tag. Want me to walk you through that? It may touch multiple tasks."

2. **Identify affected tasks.** Run `tasks list --tag <old-name>` to see what's using the old tag. Count and show the user before proceeding — they may be surprised by the number.

3. **Execute the three-step flow** (only after user confirms):
   ```bash
   # Step A: create the new tag
   ~/.claude/skills/TickTick/bin/ticktick tags create --name <new-name> --label "<new label>" --color "<same-color-as-old>"
   # Step B: for each task with the old tag, re-tag
   for task_id in ...; do
     ~/.claude/skills/TickTick/bin/ticktick tasks update --id "$task_id" --project "<project>" --title "<existing title>" --tags "<comma-separated-list-with-new-tag-replacing-old>"
   done
   # Step C: delete the old tag
   ~/.claude/skills/TickTick/bin/ticktick tags delete --name <old-name>
   ```

   Note: `tasks update --tags` takes the FULL list — you have to read each task's existing tags, swap the old for the new, and pass the full set. Don't pass just the new tag or you'll wipe other tags.

4. **Verify.** Run `tasks list --tag <new-name>` — should return the same count as step 2's `tasks list --tag <old-name>`. Run `tasks list --tag <old-name>` — should return 0 before the delete step.

## Voice notification (required before any CLI action, including the workaround)

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the RenameTag manual workaround in the TickTick skill to re-tag affected tasks"}' \
  > /dev/null 2>&1 &
```

## If the user insists on running the broken CLI command directly

If they explicitly say "no, just run the broken command, I understand it won't work" — okay, run it, but immediately report the `persisted: false` warning field and remind them nothing changed.

## Errors

- `AUTH_MISSING_CREDS` / `AUTH_FAILED` / `AUTH_EXPIRED` → as in `ListTasks.md`.
- Any non-broken error on create / delete steps → surface `.error.message` verbatim.

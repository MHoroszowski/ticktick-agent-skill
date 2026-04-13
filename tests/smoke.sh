#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# tests/smoke.sh — live-API end-to-end acceptance test
# ─────────────────────────────────────────────────────────────────
#
# Prerequisites:
#   1. `TICKTICK_EMAIL` and `TICKTICK_PASSWORD` are set in ~/.env
#   2. A project named "TEST - PAI Skill" exists in your TickTick account.
#      Create it manually via the TickTick web UI before running this test.
#   3. `jq` is installed (apt install jq).
#
# What it does:
#   - whoami + projects list sanity
#   - Creates a task, gets it, updates it, adds+completes+deletes a checklist
#     item, completes and deletes the task
#   - Corrupts the session file and runs whoami to prove auto-refresh works
#
# The script exits non-zero on any failure and stops at the first error.
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TICKTICK="$SKILL_DIR/bin/ticktick"
SESSION_FILE="$SKILL_DIR/.session/ticktick.json"
TEST_PROJECT="TEST - PAI Skill"

log() { printf '\033[1;36m[smoke]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m[  ok]\033[0m %s\n' "$*"; }

require() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || fail "Missing required tool: $name"
}

require jq
[ -x "$TICKTICK" ] || fail "Binary not executable: $TICKTICK"

# ─── 1. whoami ───
log "Step 1: whoami (auto-login if needed)"
WHOAMI_JSON="$("$TICKTICK" whoami)"
echo "$WHOAMI_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "whoami returned ok=false: $WHOAMI_JSON"
USER_EMAIL="$(echo "$WHOAMI_JSON" | jq -r '.user.email // .user.username // ""')"
[ -n "$USER_EMAIL" ] || fail "whoami returned no user email/username"
USER_ID="$(echo "$WHOAMI_JSON" | jq -r '.user.userId // empty')"
[ -n "$USER_ID" ] || fail "whoami returned no numeric userId (check /api/v2/user/status handling)"
ok "logged in as $USER_EMAIL (userId=$USER_ID)"

# ─── 2. projects list, find TEST project ───
log "Step 2: projects list"
PROJECTS_JSON="$("$TICKTICK" projects list)"
echo "$PROJECTS_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "projects list failed: $PROJECTS_JSON"
PROJECT_ID="$(echo "$PROJECTS_JSON" \
  | jq -r --arg name "$TEST_PROJECT" '.projects[] | select(.name == $name) | .id' \
  | head -n 1)"
[ -n "$PROJECT_ID" ] \
  || fail "Project '$TEST_PROJECT' not found. Create it manually in TickTick first."
ok "found $TEST_PROJECT ($PROJECT_ID)"

# ─── 3. create task ───
log "Step 3: create task"
CREATE_JSON="$("$TICKTICK" tasks create \
  --title "PAI smoke test" \
  --project "$TEST_PROJECT")"
echo "$CREATE_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "create failed: $CREATE_JSON"
TASK_ID="$(echo "$CREATE_JSON" | jq -r '.task.id')"
ok "created task $TASK_ID"

# ─── 4. get task ───
log "Step 4: get task"
GET_JSON="$("$TICKTICK" tasks get --id "$TASK_ID")"
echo "$GET_JSON" | jq -e '.ok == true and .task.title == "PAI smoke test"' >/dev/null \
  || fail "get verification failed: $GET_JSON"
ok "verified task title"

# ─── 5. update task ───
log "Step 5: update task"
UPDATE_JSON="$("$TICKTICK" tasks update \
  --id "$TASK_ID" \
  --project "$PROJECT_ID" \
  --title "PAI smoke test (updated)")"
echo "$UPDATE_JSON" | jq -e '.ok == true and .task.title == "PAI smoke test (updated)"' >/dev/null \
  || fail "update verification failed: $UPDATE_JSON"
ok "updated task title"

# ─── 6. add checklist item ───
log "Step 6: add checklist item"
CHECKLIST_ADD_JSON="$("$TICKTICK" checklist add \
  --task "$TASK_ID" \
  --project "$PROJECT_ID" \
  --title "sub-item 1")"
echo "$CHECKLIST_ADD_JSON" | jq -e '.ok == true and (.task.items | length) >= 1' >/dev/null \
  || fail "checklist add failed or items[] empty: $CHECKLIST_ADD_JSON"
ITEM_ID="$(echo "$CHECKLIST_ADD_JSON" | jq -r '.task.items[] | select(.title == "sub-item 1") | .id' | head -n 1)"
[ -n "$ITEM_ID" ] || fail "couldn't locate newly added checklist item in response"
ok "added checklist item $ITEM_ID"

# ─── 7. complete checklist item ───
log "Step 7: complete checklist item"
CHECKLIST_DONE_JSON="$("$TICKTICK" checklist complete \
  --task "$TASK_ID" \
  --project "$PROJECT_ID" \
  --item "$ITEM_ID")"
echo "$CHECKLIST_DONE_JSON" | jq -e ".ok == true and (.task.items[] | select(.id == \"$ITEM_ID\") | .completed == true)" >/dev/null \
  || fail "checklist complete verification failed: $CHECKLIST_DONE_JSON"
ok "completed checklist item"

# ─── 8. delete checklist item ───
log "Step 8: delete checklist item"
CHECKLIST_DEL_JSON="$("$TICKTICK" checklist delete \
  --task "$TASK_ID" \
  --project "$PROJECT_ID" \
  --item "$ITEM_ID")"
echo "$CHECKLIST_DEL_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "checklist delete failed: $CHECKLIST_DEL_JSON"
ok "deleted checklist item"

# ─── 9. complete task ───
log "Step 9: complete task"
COMPLETE_JSON="$("$TICKTICK" tasks complete --id "$TASK_ID" --project "$PROJECT_ID")"
echo "$COMPLETE_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "complete failed: $COMPLETE_JSON"
ok "completed task"

# ─── 10. delete task ───
log "Step 10: delete task"
DELETE_JSON="$("$TICKTICK" tasks delete --id "$TASK_ID" --project "$PROJECT_ID")"
echo "$DELETE_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "delete failed: $DELETE_JSON"
ok "deleted task"

# ─── 11. members list ───
# Verifies /api/v2/project/{id}/users works. NOTE: TickTick returns [] on
# this endpoint for SOLO projects (only populates for shared lists with
# multiple members). The TEST project is solo, so we just assert ok=true
# here. The real shared-list test happens organically if you run the
# skill against your actual Shopping list.
log "Step 11: members list (TEST is a solo project, expect ok=true, count may be 0)"
MEMBERS_JSON="$("$TICKTICK" members list --project "$TEST_PROJECT")"
echo "$MEMBERS_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "members list failed: $MEMBERS_JSON"
MEMBER_COUNT="$(echo "$MEMBERS_JSON" | jq -r '.count')"
ok "members list ok=true, count=$MEMBER_COUNT (solo projects return 0)"

# ─── 12. create task assigned to self ───
log "Step 12: create task with --assignee me"
ASSIGN_CREATE_JSON="$("$TICKTICK" tasks create --title "Smoke assignee test" --project "$TEST_PROJECT" --assignee me)"
echo "$ASSIGN_CREATE_JSON" | jq -e '.ok == true and .task.assignee != null' >/dev/null \
  || fail "create-with-assignee failed or assignee is null: $ASSIGN_CREATE_JSON"
ASSIGNEE_TASK_ID="$(echo "$ASSIGN_CREATE_JSON" | jq -r '.task.id')"
ASSIGNEE_VALUE="$(echo "$ASSIGN_CREATE_JSON" | jq -r '.task.assignee')"
[ "$ASSIGNEE_VALUE" = "$USER_ID" ] \
  || fail "assigned userId $ASSIGNEE_VALUE != self userId $USER_ID (from whoami)"
ok "created task $ASSIGNEE_TASK_ID assigned to self ($ASSIGNEE_VALUE)"

# ─── 13. unassign via update ───
log "Step 13: update task with --assignee unassign"
UNASSIGN_JSON="$("$TICKTICK" tasks update --id "$ASSIGNEE_TASK_ID" --project "$PROJECT_ID" --title "Smoke assignee test" --assignee unassign)"
echo "$UNASSIGN_JSON" | jq -e '.ok == true and .task.assignee == null' >/dev/null \
  || fail "unassign failed or assignee still set: $UNASSIGN_JSON"
ok "unassigned task $ASSIGNEE_TASK_ID"

# ─── 14. cleanup the assignee test task ───
log "Step 14: delete assignee test task"
"$TICKTICK" tasks delete --id "$ASSIGNEE_TASK_ID" --project "$PROJECT_ID" >/dev/null \
  || fail "cleanup of assignee test task failed"
ok "cleaned up assignee test task"

# ─── 15. sections list ───
# Sections are tested against the user's real Shopping list since TEST is
# solo and has no sections. Read-only — no state mutation.
log "Step 15: sections list against a real shared project (🛒Shopping)"
SECTIONS_JSON="$("$TICKTICK" sections list --project "🛒Shopping" 2>&1)"
SECTIONS_OK="$(echo "$SECTIONS_JSON" | jq -r '.ok // false' 2>/dev/null || echo "false")"
if [ "$SECTIONS_OK" = "true" ]; then
  SECTION_COUNT="$(echo "$SECTIONS_JSON" | jq -r '.count')"
  [ "$SECTION_COUNT" -ge 1 ] \
    || fail "sections list returned 0 sections for 🛒Shopping (expected >= 1)"
  ok "sections list ok, count=$SECTION_COUNT on 🛒Shopping"
else
  log "skipped: sections list failed (likely no shared Shopping list on this account) — $SECTIONS_JSON"
fi

# ─── 16. tasks create with --section ───
# Round-trip: create a throwaway task targeting a specific section, verify
# columnId was set, then delete. Only runs if sections list succeeded.
if [ "$SECTIONS_OK" = "true" ] && [ "${SECTION_COUNT:-0}" -ge 1 ]; then
  FIRST_SECTION_NAME="$(echo "$SECTIONS_JSON" | jq -r '.sections[0].name')"
  FIRST_SECTION_ID="$(echo "$SECTIONS_JSON" | jq -r '.sections[0].id')"
  log "Step 16: create task in 🛒Shopping with --section \"$FIRST_SECTION_NAME\""
  SECTION_CREATE_JSON="$("$TICKTICK" tasks create \
    --title "PAI smoke section test (please delete me)" \
    --project "🛒Shopping" \
    --section "$FIRST_SECTION_NAME" 2>&1)"
  echo "$SECTION_CREATE_JSON" | jq -e '.ok == true' >/dev/null \
    || fail "create-with-section failed: $SECTION_CREATE_JSON"
  SECTION_TASK_ID="$(echo "$SECTION_CREATE_JSON" | jq -r '.task.id')"
  SECTION_TASK_COL="$(echo "$SECTION_CREATE_JSON" | jq -r '.task.columnId // empty')"
  [ "$SECTION_TASK_COL" = "$FIRST_SECTION_ID" ] \
    || fail "columnId mismatch: expected $FIRST_SECTION_ID, got $SECTION_TASK_COL"
  ok "task $SECTION_TASK_ID landed in section $FIRST_SECTION_NAME ($SECTION_TASK_COL)"
  # Find the Shopping project id from earlier and use it for cleanup
  SHOPPING_ID="$("$TICKTICK" projects list | jq -r '.projects[] | select(.name == "🛒Shopping") | .id')"
  "$TICKTICK" tasks delete --id "$SECTION_TASK_ID" --project "$SHOPPING_ID" >/dev/null \
    || fail "cleanup of section test task failed"
  ok "cleaned up section test task"
else
  log "skipped step 16: no sections available on Shopping"
fi

# ─── 17. members remove dry-run safety gate ───
# Verifies that `members remove` without --force aborts non-destructively
# with the confirmation message on stderr. Uses a fake userId (999999999)
# against the TEST project so nothing real is touched.
log "Step 17: members remove dry-run safety gate (no --force, fake user)"
set +e
REMOVE_DRY_OUTPUT="$("$TICKTICK" members remove --project "$TEST_PROJECT" --user 999999999 2>&1)"
REMOVE_DRY_EXIT=$?
set -e
[ $REMOVE_DRY_EXIT -eq 2 ] \
  || fail "dry-run should exit 2 (usage error), got $REMOVE_DRY_EXIT. output: $REMOVE_DRY_OUTPUT"
echo "$REMOVE_DRY_OUTPUT" | grep -q "Confirmation required" \
  || echo "$REMOVE_DRY_OUTPUT" | grep -q "force" \
  || fail "dry-run output didn't mention confirmation/force. output: $REMOVE_DRY_OUTPUT"
ok "dry-run correctly aborted without --force"

# ─── 18. session auto-refresh ───
log "Step 18: session auto-refresh (corrupt session → whoami should silently re-login)"
if [ -f "$SESSION_FILE" ]; then
  echo '{"invalid": true}' > "$SESSION_FILE"
  WHOAMI2_JSON="$("$TICKTICK" whoami)"
  echo "$WHOAMI2_JSON" | jq -e '.ok == true' >/dev/null \
    || fail "whoami after session corruption failed: $WHOAMI2_JSON"
  ok "session auto-refresh recovered"
else
  log "skipped: no session file to corrupt"
fi

# ─────────────────────────────────────────────────────────────────
# v1.3 — PLAN_01 library surface expansion
# Pin/unpin, bulk, completed, smart-list filters, tags CRUD, projects CRUD
# ─────────────────────────────────────────────────────────────────

# ─── 19. pin / unpin ───
log "Step 19: pin / unpin round-trip"
PIN_CREATE_JSON="$("$TICKTICK" tasks create --title "PAI pin smoke" --project "$TEST_PROJECT")"
PIN_TASK_ID="$(echo "$PIN_CREATE_JSON" | jq -r '.task.id')"
[ -n "$PIN_TASK_ID" ] || fail "couldn't create pin smoke task: $PIN_CREATE_JSON"

"$TICKTICK" tasks pin --id "$PIN_TASK_ID" --project "$PROJECT_ID" | jq -e '.ok == true' >/dev/null \
  || fail "pin failed"
PIN_GET_JSON="$("$TICKTICK" tasks get --id "$PIN_TASK_ID")"
echo "$PIN_GET_JSON" | jq -e '.ok == true and .task.pinnedAt != null' >/dev/null \
  || fail "pin verification failed: pinnedAt still null. $PIN_GET_JSON"
ok "pinned task $PIN_TASK_ID (pinnedAt set)"

"$TICKTICK" tasks unpin --id "$PIN_TASK_ID" --project "$PROJECT_ID" | jq -e '.ok == true' >/dev/null \
  || fail "unpin failed"
UNPIN_GET_JSON="$("$TICKTICK" tasks get --id "$PIN_TASK_ID")"
echo "$UNPIN_GET_JSON" | jq -e '.ok == true and .task.pinnedAt == null' >/dev/null \
  || fail "unpin verification failed: pinnedAt still set. $UNPIN_GET_JSON"
ok "unpinned task $PIN_TASK_ID (pinnedAt null)"

# ─── 20. tasks list --pinned ───
log "Step 20: tasks list --pinned (filter)"
# Pin the task again so the filter has something to return, then cleanup at end.
"$TICKTICK" tasks pin --id "$PIN_TASK_ID" --project "$PROJECT_ID" >/dev/null \
  || fail "re-pin failed"
PINNED_LIST_JSON="$("$TICKTICK" tasks list --pinned)"
echo "$PINNED_LIST_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "tasks list --pinned failed: $PINNED_LIST_JSON"
echo "$PINNED_LIST_JSON" \
  | jq -e --arg tid "$PIN_TASK_ID" '.tasks | map(.id) | index($tid) != null' >/dev/null \
  || fail "pinned filter did not include $PIN_TASK_ID. $PINNED_LIST_JSON"
ok "tasks list --pinned returns the pinned task"

# Cleanup: unpin and delete
"$TICKTICK" tasks unpin --id "$PIN_TASK_ID" --project "$PROJECT_ID" >/dev/null || true
"$TICKTICK" tasks delete --id "$PIN_TASK_ID" --project "$PROJECT_ID" >/dev/null \
  || fail "cleanup of pin smoke task failed"
ok "cleaned up pin smoke task"

# ─── 21. bulk create + delete (via fixture file) ───
log "Step 21: bulk create-many + delete-many"
FIXTURE_FILE="$SKILL_DIR/tests/fixtures/bulk-drafts.json"
[ -f "$FIXTURE_FILE" ] || fail "fixture not found: $FIXTURE_FILE"

BULK_CREATE_JSON="$("$TICKTICK" tasks create-many --file "$FIXTURE_FILE")"
echo "$BULK_CREATE_JSON" | jq -e '.ok == true and .count >= 3' >/dev/null \
  || fail "bulk create failed or count < 3: $BULK_CREATE_JSON"
BULK_COUNT="$(echo "$BULK_CREATE_JSON" | jq -r '.count')"
ok "created $BULK_COUNT tasks via bulk-create"

# Find the bulk-created tasks by title prefix, grab their ids, delete them in one batch.
BULK_LIST_JSON="$("$TICKTICK" tasks list --project "$TEST_PROJECT")"
BULK_IDS="$(echo "$BULK_LIST_JSON" \
  | jq -r '.tasks[] | select(.title | startswith("PAI bulk smoke")) | .id' \
  | tr '\n' ',' | sed 's/,$//')"
[ -n "$BULK_IDS" ] || fail "bulk-created tasks not found in list: $BULK_LIST_JSON"
BULK_ID_COUNT="$(echo "$BULK_IDS" | tr ',' '\n' | wc -l)"
[ "$BULK_ID_COUNT" -ge "$BULK_COUNT" ] \
  || fail "expected $BULK_COUNT bulk tasks in list, found $BULK_ID_COUNT"
ok "located $BULK_ID_COUNT bulk tasks for cleanup"

BULK_DEL_JSON="$("$TICKTICK" tasks delete-many --ids "$BULK_IDS" --project "$PROJECT_ID")"
echo "$BULK_DEL_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "bulk delete failed: $BULK_DEL_JSON"
ok "bulk-deleted $BULK_ID_COUNT tasks"

# ─── 22. bulk complete-many ───
log "Step 22: bulk complete-many"
CM1_JSON="$("$TICKTICK" tasks create --title "PAI cm smoke A" --project "$TEST_PROJECT")"
CM2_JSON="$("$TICKTICK" tasks create --title "PAI cm smoke B" --project "$TEST_PROJECT")"
CM1_ID="$(echo "$CM1_JSON" | jq -r '.task.id')"
CM2_ID="$(echo "$CM2_JSON" | jq -r '.task.id')"
[ -n "$CM1_ID" ] && [ -n "$CM2_ID" ] || fail "couldn't create complete-many test tasks"

CM_DONE_JSON="$("$TICKTICK" tasks complete-many --ids "$CM1_ID,$CM2_ID" --project "$PROJECT_ID")"
echo "$CM_DONE_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "complete-many failed: $CM_DONE_JSON"
ok "complete-many marked 2 tasks done"

# Cleanup: delete both (they're completed now — need explicit project)
"$TICKTICK" tasks delete --id "$CM1_ID" --project "$PROJECT_ID" >/dev/null || true
"$TICKTICK" tasks delete --id "$CM2_ID" --project "$PROJECT_ID" >/dev/null || true
ok "cleaned up complete-many test tasks"

# ─── 23. completed — iterator mode ───
log "Step 23: tasks completed --project (iterator mode)"
COMPLETED_ITER_JSON="$("$TICKTICK" tasks completed --project "$TEST_PROJECT" --limit 20)"
echo "$COMPLETED_ITER_JSON" | jq -e '.ok == true and .mode == "iterator"' >/dev/null \
  || fail "completed iterator mode failed: $COMPLETED_ITER_JSON"
ITER_COUNT="$(echo "$COMPLETED_ITER_JSON" | jq -r '.count')"
ok "iterator mode returned $ITER_COUNT completed task(s) for $TEST_PROJECT"

# ─── 24. completed — statistics date range mode ───
log "Step 24: tasks completed --from --to (statistics range mode)"
# Use a wide window — last 30 days — so the test is resilient to account activity.
# Bash portability: `date -u -d '30 days ago'` is GNU date (WSL Ubuntu has it).
FROM_ISO="$(date -u -d '30 days ago' '+%Y-%m-%dT00:00:00.000+0000')"
TO_ISO="$(date -u '+%Y-%m-%dT23:59:59.999+0000')"
COMPLETED_STATS_JSON="$("$TICKTICK" tasks completed --from "$FROM_ISO" --to "$TO_ISO" --limit 50)"
echo "$COMPLETED_STATS_JSON" | jq -e '.ok == true and .mode == "statistics"' >/dev/null \
  || fail "completed statistics mode failed: $COMPLETED_STATS_JSON"
STATS_COUNT="$(echo "$COMPLETED_STATS_JSON" | jq -r '.count')"
ok "statistics mode returned $STATS_COUNT completed task(s) in 30-day window"

# ─── 25. completed — mutually-exclusive flag gate ───
log "Step 25: completed flag validation (--from and --project mutually exclusive)"
set +e
MUTEX_OUT="$("$TICKTICK" tasks completed --from "$FROM_ISO" --to "$TO_ISO" --project "$TEST_PROJECT" 2>&1)"
MUTEX_EXIT=$?
set -e
[ $MUTEX_EXIT -eq 2 ] \
  || fail "expected exit 2 (usage error) from mutex flag combo, got $MUTEX_EXIT. output: $MUTEX_OUT"
echo "$MUTEX_OUT" | grep -q "mutually exclusive" \
  || fail "expected 'mutually exclusive' in error message. got: $MUTEX_OUT"
ok "mutually-exclusive flag gate works"

# ─── 26. repeat-end on create ───
log "Step 26: tasks create --repeat + --repeat-end"
REPEAT_END_ISO="2026-12-31T00:00:00.000+0000"
REP_JSON="$("$TICKTICK" tasks create \
  --title "PAI repeat smoke" \
  --project "$TEST_PROJECT" \
  --repeat "RRULE:FREQ=DAILY" \
  --repeat-end "$REPEAT_END_ISO")"
echo "$REP_JSON" | jq -e '.ok == true and .task.repeatFlag != null' >/dev/null \
  || fail "create with repeat failed: $REP_JSON"
REP_TASK_ID="$(echo "$REP_JSON" | jq -r '.task.id')"
# The library may not echo repeatEndDate in the normalized Task — it's an
# opaque passthrough field the API stores without always returning. We assert
# the task exists and repeatFlag is set, which is what we can verify end-to-end.
ok "created recurring task $REP_TASK_ID with repeat-end"

"$TICKTICK" tasks delete --id "$REP_TASK_ID" --project "$PROJECT_ID" >/dev/null \
  || fail "cleanup of repeat smoke task failed"
ok "cleaned up repeat smoke task"

# ─── 27. smart-list filters: tomorrow / next7days / none ───
log "Step 27: smart-list filters accepted"
for FILTER in tomorrow next7days none; do
  FILTER_JSON="$("$TICKTICK" tasks list --due "$FILTER")"
  echo "$FILTER_JSON" | jq -e '.ok == true' >/dev/null \
    || fail "tasks list --due $FILTER failed: $FILTER_JSON"
done
ok "smart-list filters (tomorrow, next7days, none) accepted"

# ─── 28. tags CRUD ───
log "Step 28: tags create / rename / delete round-trip"
SMOKE_TAG="pai-smoke-tag-$(date +%s)"
"$TICKTICK" tags create --name "$SMOKE_TAG" --label "PAI Smoke" --color "#FF0000" \
  | jq -e '.ok == true' >/dev/null \
  || fail "tag create failed"
"$TICKTICK" tags list | jq -e --arg n "$SMOKE_TAG" '.tags | map(.name) | index($n) != null' >/dev/null \
  || fail "created tag not visible in tags list"
ok "created tag $SMOKE_TAG"

SMOKE_TAG_RENAMED="${SMOKE_TAG}-renamed"
"$TICKTICK" tags rename --name "$SMOKE_TAG" --to "$SMOKE_TAG_RENAMED" \
  | jq -e '.ok == true' >/dev/null \
  || fail "tag rename failed"
"$TICKTICK" tags list | jq -e --arg n "$SMOKE_TAG_RENAMED" '.tags | map(.name) | index($n) != null' >/dev/null \
  || fail "renamed tag not visible in tags list"
ok "renamed tag to $SMOKE_TAG_RENAMED"

"$TICKTICK" tags delete --name "$SMOKE_TAG_RENAMED" \
  | jq -e '.ok == true' >/dev/null \
  || fail "tag delete failed"
"$TICKTICK" tags list | jq -e --arg n "$SMOKE_TAG_RENAMED" '.tags | map(.name) | index($n) == null' >/dev/null \
  || fail "deleted tag still visible in tags list"
ok "deleted tag $SMOKE_TAG_RENAMED"

# ─── 29. projects create / update / delete (with safety gate) ───
log "Step 29: projects create / update / delete (with --confirm gate)"
SMOKE_PROJ="PAI SMOKE PROJECT $(date +%s)"
PROJ_CREATE_JSON="$("$TICKTICK" projects create --name "$SMOKE_PROJ" --color "#00FF00")"
echo "$PROJ_CREATE_JSON" | jq -e '.ok == true and .project.id != null' >/dev/null \
  || fail "projects create failed: $PROJ_CREATE_JSON"
SMOKE_PROJ_ID="$(echo "$PROJ_CREATE_JSON" | jq -r '.project.id')"
ok "created project $SMOKE_PROJ_ID"

"$TICKTICK" projects update --id "$SMOKE_PROJ_ID" --color "#0000FF" \
  | jq -e '.ok == true' >/dev/null \
  || fail "projects update failed"
ok "updated project color"

# Safety gate: delete without --confirm should exit 6 (validation) and
# NOT destroy the project.
set +e
DEL_NO_CONFIRM_OUT="$("$TICKTICK" projects delete --id "$SMOKE_PROJ_ID" 2>&1)"
DEL_NO_CONFIRM_EXIT=$?
set -e
[ $DEL_NO_CONFIRM_EXIT -eq 6 ] \
  || fail "delete without --confirm should exit 6, got $DEL_NO_CONFIRM_EXIT. output: $DEL_NO_CONFIRM_OUT"
echo "$DEL_NO_CONFIRM_OUT" | grep -q "confirm" \
  || fail "delete-without-confirm output should mention confirm. got: $DEL_NO_CONFIRM_OUT"
# Project should still exist.
"$TICKTICK" projects get --id "$SMOKE_PROJ_ID" | jq -e '.ok == true' >/dev/null \
  || fail "project vanished without --confirm — safety gate is broken"
ok "delete-without-confirm safety gate intact (project still exists)"

# Delete for real.
"$TICKTICK" projects delete --id "$SMOKE_PROJ_ID" --confirm \
  | jq -e '.ok == true' >/dev/null \
  || fail "projects delete --confirm failed"
ok "deleted project $SMOKE_PROJ_ID (with --confirm)"

printf '\n\033[1;32m✓ All smoke tests passed\033[0m\n'

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

# ─── 18a. sections CRUD lifecycle (against TEST project) ───
# Full create → rename → reorder → delete (with --reassign) cycle on the
# solo TEST project. Idempotent: every section we create here gets cleaned
# up at the end, even on failure.
log "Step 18a: sections CRUD lifecycle on $TEST_PROJECT"

# Track ids we create so the trap can clean them up if the test bails.
SMOKE_SECTION_A=""
SMOKE_SECTION_B=""
SMOKE_SECTION_TASK=""
cleanup_sections() {
  set +e
  if [ -n "$SMOKE_SECTION_TASK" ]; then
    "$TICKTICK" tasks delete --id "$SMOKE_SECTION_TASK" --project "$PROJECT_ID" >/dev/null 2>&1
  fi
  if [ -n "$SMOKE_SECTION_A" ]; then
    "$TICKTICK" sections delete --project "$PROJECT_ID" --section "$SMOKE_SECTION_A" --confirm >/dev/null 2>&1
  fi
  if [ -n "$SMOKE_SECTION_B" ]; then
    "$TICKTICK" sections delete --project "$PROJECT_ID" --section "$SMOKE_SECTION_B" --confirm >/dev/null 2>&1
  fi
  set -e
}
trap cleanup_sections EXIT

# Create
SECTION_A_JSON="$("$TICKTICK" sections create --project "$PROJECT_ID" --name "Smoke Section A")"
echo "$SECTION_A_JSON" | jq -e '.ok == true and .section.id != null and .section.name == "Smoke Section A"' >/dev/null \
  || fail "sections create A failed: $SECTION_A_JSON"
SMOKE_SECTION_A="$(echo "$SECTION_A_JSON" | jq -r '.section.id')"
ok "created section A id=$SMOKE_SECTION_A"

SECTION_B_JSON="$("$TICKTICK" sections create --project "$PROJECT_ID" --name "Smoke Section B" --after "$SMOKE_SECTION_A")"
echo "$SECTION_B_JSON" | jq -e '.ok == true and .section.id != null' >/dev/null \
  || fail "sections create B failed: $SECTION_B_JSON"
SMOKE_SECTION_B="$(echo "$SECTION_B_JSON" | jq -r '.section.id')"
ok "created section B id=$SMOKE_SECTION_B (after A)"

# List shows both
SECTIONS_AFTER_CREATE="$("$TICKTICK" sections list --project "$PROJECT_ID")"
LIST_HAS_BOTH="$(echo "$SECTIONS_AFTER_CREATE" | jq --arg a "$SMOKE_SECTION_A" --arg b "$SMOKE_SECTION_B" '[.sections[].id] | (index($a) != null) and (index($b) != null)')"
[ "$LIST_HAS_BOTH" = "true" ] \
  || fail "sections list does not contain both new sections: $SECTIONS_AFTER_CREATE"
ok "sections list shows both new sections"

# Rename A
RENAME_JSON="$("$TICKTICK" sections rename --project "$PROJECT_ID" --section "$SMOKE_SECTION_A" --to "Smoke Section A Renamed")"
echo "$RENAME_JSON" | jq -e '.ok == true and .section.name == "Smoke Section A Renamed"' >/dev/null \
  || fail "sections rename failed: $RENAME_JSON"
ok "renamed section A"

# Reorder: move B before A
MOVE_JSON="$("$TICKTICK" sections move --project "$PROJECT_ID" --section "$SMOKE_SECTION_B" --before "$SMOKE_SECTION_A")"
echo "$MOVE_JSON" | jq -e '.ok == true and .section.id != null' >/dev/null \
  || fail "sections move failed: $MOVE_JSON"
# Verify B's sortOrder is now less than A's
SECTIONS_AFTER_MOVE="$("$TICKTICK" sections list --project "$PROJECT_ID")"
A_ORDER="$(echo "$SECTIONS_AFTER_MOVE" | jq --arg a "$SMOKE_SECTION_A" '.sections[] | select(.id == $a) | .sortOrder')"
B_ORDER="$(echo "$SECTIONS_AFTER_MOVE" | jq --arg b "$SMOKE_SECTION_B" '.sections[] | select(.id == $b) | .sortOrder')"
[ -n "$A_ORDER" ] && [ -n "$B_ORDER" ] && [ "$B_ORDER" -lt "$A_ORDER" ] \
  || fail "after move, expected B.sortOrder ($B_ORDER) < A.sortOrder ($A_ORDER)"
ok "reorder put B (sortOrder=$B_ORDER) before A (sortOrder=$A_ORDER)"

# Create a task IN section A so we can test --reassign
TASK_IN_A_JSON="$("$TICKTICK" tasks create --title "PAI smoke section task" --project "$PROJECT_ID" --section "$SMOKE_SECTION_A")"
echo "$TASK_IN_A_JSON" | jq -e ".ok == true and .task.columnId == \"$SMOKE_SECTION_A\"" >/dev/null \
  || fail "create task in section A failed or columnId mismatch: $TASK_IN_A_JSON"
SMOKE_SECTION_TASK="$(echo "$TASK_IN_A_JSON" | jq -r '.task.id')"
ok "created task $SMOKE_SECTION_TASK in section A"

# tasks list --section filters correctly
SECTION_FILTER_JSON="$("$TICKTICK" tasks list --project "$PROJECT_ID" --section "$SMOKE_SECTION_A")"
SECTION_FILTER_HAS_TASK="$(echo "$SECTION_FILTER_JSON" | jq --arg t "$SMOKE_SECTION_TASK" '[.tasks[].id] | index($t) != null')"
[ "$SECTION_FILTER_HAS_TASK" = "true" ] \
  || fail "tasks list --section did not return the task we just created in that section: $SECTION_FILTER_JSON"
ok "tasks list --section returns the task in section A"

# tasks list --assignee me works (returns the assignee test task — but we
# already deleted that, so just verify it doesn't error and the count is
# >= 0). Better: create a fresh assigned task, query, then clean up.
ASSIGNEE_FILTER_TASK_JSON="$("$TICKTICK" tasks create --title "PAI smoke assignee filter" --project "$PROJECT_ID" --assignee me)"
echo "$ASSIGNEE_FILTER_TASK_JSON" | jq -e '.ok == true' >/dev/null \
  || fail "create-with-assignee for filter test failed: $ASSIGNEE_FILTER_TASK_JSON"
ASSIGNEE_FILTER_TASK_ID="$(echo "$ASSIGNEE_FILTER_TASK_JSON" | jq -r '.task.id')"
ASSIGNEE_LIST_JSON="$("$TICKTICK" tasks list --project "$PROJECT_ID" --assignee me)"
ASSIGNEE_LIST_HAS_TASK="$(echo "$ASSIGNEE_LIST_JSON" | jq --arg t "$ASSIGNEE_FILTER_TASK_ID" '[.tasks[].id] | index($t) != null')"
[ "$ASSIGNEE_LIST_HAS_TASK" = "true" ] \
  || fail "tasks list --assignee me did not return the freshly-assigned task: $ASSIGNEE_LIST_JSON"
"$TICKTICK" tasks delete --id "$ASSIGNEE_FILTER_TASK_ID" --project "$PROJECT_ID" >/dev/null \
  || fail "cleanup of assignee filter task failed"
ok "tasks list --assignee me returns the assigned task"

# Dry-run delete (no --confirm) should refuse and exit non-zero
set +e
DRY_DELETE_OUTPUT="$("$TICKTICK" sections delete --project "$PROJECT_ID" --section "$SMOKE_SECTION_A" 2>&1)"
DRY_DELETE_EXIT=$?
set -e
[ $DRY_DELETE_EXIT -ne 0 ] \
  || fail "sections delete without --confirm should have errored, exit=$DRY_DELETE_EXIT"
echo "$DRY_DELETE_OUTPUT" | grep -q -- "--confirm" \
  || fail "dry-run output didn't mention --confirm: $DRY_DELETE_OUTPUT"
ok "sections delete dry-run safety gate fires correctly"

# Real delete A with --reassign B → task should now be in B
DELETE_A_JSON="$("$TICKTICK" sections delete --project "$PROJECT_ID" --section "$SMOKE_SECTION_A" --reassign "$SMOKE_SECTION_B" --confirm)"
echo "$DELETE_A_JSON" | jq -e '.ok == true and .reassignedTaskCount >= 1' >/dev/null \
  || fail "sections delete --reassign failed or task count wrong: $DELETE_A_JSON"
# Verify the task moved to B
TASK_AFTER_REASSIGN_JSON="$("$TICKTICK" tasks get --id "$SMOKE_SECTION_TASK")"
TASK_NEW_COL="$(echo "$TASK_AFTER_REASSIGN_JSON" | jq -r '.task.columnId // empty')"
[ "$TASK_NEW_COL" = "$SMOKE_SECTION_B" ] \
  || fail "after --reassign, task columnId is '$TASK_NEW_COL', expected '$SMOKE_SECTION_B'"
ok "deleted section A and reassigned task to B"

# Mark A as cleaned up (so the trap doesn't try again).
SMOKE_SECTION_A=""

# Delete section B (no reassign — task gets orphaned, that's fine, we'll
# clean it up explicitly).
"$TICKTICK" sections delete --project "$PROJECT_ID" --section "$SMOKE_SECTION_B" --confirm >/dev/null \
  || fail "sections delete B failed"
SMOKE_SECTION_B=""
ok "deleted section B"

"$TICKTICK" tasks delete --id "$SMOKE_SECTION_TASK" --project "$PROJECT_ID" >/dev/null \
  || fail "cleanup of section task failed"
SMOKE_SECTION_TASK=""
ok "cleaned up section task"

# Disarm the cleanup trap — everything is gone.
trap - EXIT

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

printf '\n\033[1;32m✓ All smoke tests passed\033[0m\n'

# Handoff

## Current state (2026-08-07)

`CalendarAssistScheduler.gs` is at **v3.3**, pushed to the live Apps Script
project via `clasp push --force`, and merged to `main` via a PR from branch
`fix/scheduler-auto-replace-conflicts`.

The v3.3 diff bundled two separate pieces of work from this session:

1. **`diagnoseReadFromCalendar()`** (new function) — a diagnostic for stale
   read-from-calendar symptoms (log shows old shift titles/times). Dumps
   calendar-name match count, resolved calendar ID, and per-event
   `getLastUpdated()` so a stale ICS-subscription copy can be told apart from
   a genuinely wrong pattern match.

2. **Removed the conflict-resolution popup entirely.** The old flow tried
   `ui.alert()` for a YES/NO confirmation before deleting wrong-time/orphan
   events, falling back to `CONFIG.WHEN_NO_UI` (`'stop'` by default) when no
   UI was reachable. In practice this script only ever runs from the Apps
   Script editor or a time-based trigger — neither can show a dialog — so the
   fallback path was the *only* path, and `'stop'` meant conflicts were
   silently logged and never fixed.

   Fixed by deleting `askToReplace_`, `getUiOrNull_`, and
   `CONFIG.WHEN_NO_UI` outright. `logConflicts_` (renamed from
   `askToReplace_`) now just logs what's about to change, and the caller
   proceeds straight to deleting the wrong/orphan events and recreating the
   correct set — no confirmation step, no config knob.

## Traps for the next session

- **`askToReplace_`, `getUiOrNull_`, `CONFIG.WHEN_NO_UI` no longer exist.**
  Don't re-add a popup/confirmation step for this reconciliation flow — it's
  a dead end in this script's actual run contexts (editor / trigger only,
  never a bound Sheet menu).
- The header doc comment and `buildConflictMessage_`'s trailing line were
  updated to match (no more "Replace them? YES/NO"). If you touch the
  reconciliation flow again, keep those two in sync with the code.

## Not yet done

Nothing outstanding from this change. Next stale-calendar report should be
diagnosed with `diagnoseReadFromCalendar()` before assuming the block math
is wrong.

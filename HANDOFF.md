# Handoff

## Current state (2026-09-14)

`CalendarAssistScheduler.gs` is at **v3.4**, pushed to the live Apps Script project via
`clasp push --force`.

This session first synced local to live (`clasp pull` showed one drift: `runForWeek(n)` had
gained a default parameter, `n=0`, from an editor-side edit — merged in as a baseline commit),
then fixed two real bugs and cleaned up duplication:

1. **DST-unsafe week window.** `createAssistEvents`, `diagnoseReadFromCalendar`, and
   `deleteAssistEventsInTargetWeek` all computed the window end as
   `addMinutes_(weekStart, NUM_DAYS * 24 * 60)` — a fixed elapsed-minutes offset. On the
   spring-forward week this landed at 23:00 Friday (dropping the last hour); on fall-back,
   01:00 Saturday. Fixed with a new `addDays_()` helper that does calendar-date arithmetic
   (matches how `getTargetSunday_` already builds midnight-local dates), used via a new
   `getWeekWindow_(offset)` helper.

2. **Out-of-week helper events were invisible to reconcile.** `findAssistEvents_` was scanned
   over exactly the Sun-Fri shift window. A block anchored far enough from its shift's
   START/END (e.g. "Prep lunch", START-75, for an early-Sunday shift) lands on *Saturday* —
   outside that window. Reconcile then saw it as `missing` every run, and `SKIP_DUPLICATES`
   blocked recreating it, so it could also never be cleaned up as an orphan if the shift moved.
   Fixed: `getWeekWindow_` now also returns a `scanStart`/`scanEnd` padded by
   `maxBlockOffsetMin_()` (the largest `|startOffsetMin|`/`|endOffsetMin|` across
   `CONFIG.BLOCKS`, rounded up to whole days). The *shift read* window is unchanged; only the
   *write-to reconcile scan* is padded, and `findAssistEvents_` still filters to managed
   titles, so nothing outside the block titles is ever returned by the wider scan.

3. **Cleanup:** deduped the `weekOffset` trigger-event-object guard (now `resolveWeekOffset_`)
   and the week-window math (now `getWeekWindow_`) across the three call sites.
   `deleteAssistEventsInTargetWeek` now reuses `deleteEvents_` (try/catch per event, doesn't
   abort the whole run on one failure) instead of a bare `deleteEvent()` loop.
   `validateBlocks_` now also rejects a block with an invalid `color` name or a
   non-numeric/non-null `popupReminderMin` at validation time, before any events are written
   (previously a bad color only warned per-event after creation, and a bad reminder value
   silently dropped just that one event via the `createEventSafely_` catch).

## Traps for the next session

- **`askToReplace_`, `getUiOrNull_`, `CONFIG.WHEN_NO_UI` no longer exist** (removed in v3.3).
  Don't re-add a popup/confirmation step for the reconciliation flow — this script only runs
  from the Apps Script editor or a time-based trigger, neither of which can show a dialog.
- **The reconcile *scan* window is now wider than the shift *processing* window.** If you add
  logic that reads `findAssistEvents_`'s result and assumes it is bounded by
  `weekStart`/`weekEnd`, it isn't — it's bounded by `window.scanStart`/`window.scanEnd`. Read
  events are still bounded by `weekStart`/`weekEnd`.
- Two known gaps intentionally left out of this pass (flagged during review, not built):
  - Managed events are matched by **title only** — a hand-made event on the write-to calendar
    happening to be named e.g. "Prep lunch" is indistinguishable from one this script created,
    and is fair game to be treated as an orphan and deleted. Adding an ownership marker (e.g. a
    tag in the event description) would need a one-time migration for existing events.
  - Reconcile only compares start/end times. An existing event with the correct times but the
    wrong color or reminder is left alone — drift there is silent.

## Not yet done

Nothing outstanding from this change. Next stale-calendar report should be diagnosed with
`diagnoseReadFromCalendar()` before assuming the block math is wrong.

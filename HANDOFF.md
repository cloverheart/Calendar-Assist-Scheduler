# Handoff

## v3.6 (2026-09-25) — Eve mirror: 15 min, default color

Mirrors are now `CONFIG.EVE_MINING.DURATION_MIN` (15) long — the in-game duration is ignored — and
`COLOR: ''` uses the calendar's default color (assumed to be the green the user means; if wrong,
set `COLOR` to `'GREEN'`/`'PALE_GREEN'` and run `resetEveMirrors`). Existing mirrors re-time to 15 min
on the next sync, but the API cannot reset an event to the default color, so `resetEveMirrors()`
(new) deletes future mirrors + clears `ESI_MIRRORED_IDS` and the next sync recreates them.
Not verified live: the reset + recreate, and that the default color is the intended green.

## v3.5 (2026-09-25) — Eve "Mining" mirror (start = in-game date; length since changed, see v3.6)

Added `syncEveMiningEvents` / `installEveMiningTrigger` (+ `fetchEveMiningItems_`,
`indexEveMirrors_`, `createEveMirror_`, `esiGetEventDetail_`, ESI helpers `esi*`,
`CONFIG.EVE_MINING`, `ESI_PROP_KEYS`). The in-game Eve calendar has no Google feed, so it is read
from Eve ESI (`esi-calendar.read_calendar_events.v1`) with a refresh token in Script Properties
(`ESI_CLIENT_ID`, `ESI_CLIENT_SECRET`, `ESI_REFRESH_TOKEN`, `ESI_MIRRORED_IDS`; kept out of
`PROP_KEYS` so `clearCalendarProperties` can't wipe them). Items with "Mining" in the title and
owner_type in `CONFIG.EVE_MINING.OWNER_TYPES` (default corporation) become timed events on the
write-to calendar (`Eve: <title>`, start = in-game date, end = start + `DURATION_MIN`, originally the ESI duration). A Google Task
was requested but Tasks store only a date, so a timed calendar event is used.

Sync behaviour (after review fixes): mirrors are found by an `EVE_SRC:<event_id>` FIRST description
line. New item -> created. Re-timed in-game item -> its mirror is re-timed (no duplicate). Mirror
deleted by hand -> NOT recreated (id kept in `ESI_MIRRORED_IDS`; delete that property to reset).
Item gone from the in-game list -> its future mirror is deleted, only when the ESI read was
complete (not cut by `MAX_PAGES`); started/past mirrors are never deleted. Auth failure THROWS so
the trigger run shows as failed — turn on failure notifications for the trigger or it fails
unseen. Item detail is cached 6 h per event id (re-fetched if date/title change), so a body-
only edit can take up to 6 h to show (duration is ignored since v3.6). Poll is hourly (ESI has no push). A 401 clears the
cached access token.

Do not assume ESI list order: pages are read up to `MAX_PAGES` and out-of-window items skipped
individually (early stop was removed on purpose).

Verified live (2026-09-25): the ORIGINAL v3.5 build read 4 corp Mining items from ESI and created
4 mirrors on the primary calendar (owner_type "corporation" accepted, times correct).
NOT verified: everything added after that review — re-time/update path, gone-item deletion,
hand-delete suppression, detail cache, 401/429 retry, the throw-on-auth-failure path, the hourly
trigger (`installEveMiningTrigger` not confirmed run), refresh-token rotation. No test suite
exists; only `node --check` syntax was run. The Eve `code` / client secret are blank in the repo
and were re-pushed blank; keep the editor copy blank.

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

v3.5: live-verify the Eve mirror paths listed under "NOT verified" above (run `syncEveMiningEvents`
twice; expect `unchanged N` on the second), then run `installEveMiningTrigger`. Otherwise nothing
outstanding. Next stale-calendar report should be diagnosed with
`diagnoseReadFromCalendar()` before assuming the block math is wrong.

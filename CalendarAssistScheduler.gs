/**
 * ============================================================================
 * FILE: CalendarAssistScheduler.gs
 * Version: 3.3 | Updated: 2026-08-07
 * ----------------------------------------------------------------------------
 * PURPOSE:
 *   Reads a shared "read-from" Google Calendar for a target week (Sun–Fri), finds
 *   the work shifts on it, and automatically creates one or more helper events
 *   on a "write-to" calendar for each shift (e.g. lunch prep, drive to work,
 *   drive from work).
 *
 *   WHICH helper events get created is fully data-driven: they are defined in
 *   the CONFIG.BLOCKS list below. Add, remove, or edit a block and the whole
 *   pipeline (create, reconcile, replace, delete, per-block reminders/colors)
 *   follows automatically — you never touch the logic.
 *
 * WHERE THE CALENDAR IDS LIVE — READ THIS:
 *   The read-from/write-to calendar IDs and names are NOT stored in this file. They
 *   live in Script Properties so the code stays generic and shareable, and no
 *   personal calendar addresses are committed to source. Set them once with
 *   setupCalendarProperties() (or via Project Settings > Script Properties).
 *   Keys used:
 *       READ_FROM_CALENDAR_ID    READ_FROM_CALENDAR_NAME
 *       WRITE_TO_CALENDAR_ID     WRITE_TO_CALENDAR_NAME
 *
 * HOW A BLOCK'S TIMES ARE CALCULATED:
 *   Each block is anchored to either the shift START or the shift END, then
 *   offset by a number of minutes for its own start and end:
 *       blockStart = anchorTime + startOffsetMin
 *       blockEnd   = anchorTime + endOffsetMin
 *   (Negative offsets are before the anchor, positive are after.)
 *   The three default blocks reproduce the original behavior:
 *       Prep lunch      : START - 75  ..  START - 45   (anchor START)
 *       Drive to work   : START - 45  ..  START + 30   (anchor START)
 *       Drive from work : END   - 45  ..  END   + 30   (anchor END)
 *
 * RECONCILE BEHAVIOR:
 *   Before writing anything, the script reads the target week on the write-to
 *   calendar and compares any existing managed events (those whose title is one
 *   of the block titles) against the times it just calculated:
 *       - Existing event, correct start AND end   -> LEFT ALONE.
 *       - Existing event, wrong start or end      -> needs replacing.
 *       - Existing event with no matching shift   -> orphan, needs removing.
 *       - Missing event                           -> will be created.
 *   If anything needs replacing/removing, the differences are logged and then
 *   fixed automatically: the wrong/orphan events are deleted and the correct
 *   set is created. There is no confirmation step — this always runs from the
 *   Apps Script editor or a time-based trigger, neither of which can show a
 *   pop-up, so there is no one available to answer one.
 *
 * FUNCTIONS YOU CAN RUN:
 *   setupCalendarProperties       - store the calendar IDs/names (run once).
 *   listCalendarProperties        - print the currently stored calendar props.
 *   clearCalendarProperties       - wipe all four calendar props.
 *   listAllMyCalendars            - print every calendar's name + ID.
 *   diagnoseReadFromCalendar      - dump the raw read-from events + last-updated
 *                                   times. Run this when the log shows STALE
 *                                   shift titles/times.
 *   createAssistEvents            - build the helper events (main entry point).
 *   runForThisWeek/NextWeek/...   - week-specific wrappers (trigger-safe).
 *   installWeeklyTrigger          - auto-run every Friday for a chosen week.
 *   deleteAssistEventsInTargetWeek- remove events THIS script made (clean redo).
 * ============================================================================
 */


/* ============================================================================
 * SCRIPT PROPERTY KEYS — where the calendar IDs/names are stored.
 * ==========================================================================*/
var PROP_KEYS = {
  READ_FROM_CALENDAR_ID: 'READ_FROM_CALENDAR_ID',
  READ_FROM_CALENDAR_NAME: 'READ_FROM_CALENDAR_NAME',
  WRITE_TO_CALENDAR_ID: 'WRITE_TO_CALENDAR_ID',
  WRITE_TO_CALENDAR_NAME: 'WRITE_TO_CALENDAR_NAME'
};


/* ============================================================================
 * CONFIG — CENTRALIZED SETTINGS (no personal / identifying data here)
 * ----------------------------------------------------------------------------
 * Calendar IDs/names are NOT here — they live in Script Properties (see
 * setupCalendarProperties). Everything else you might tune lives below.
 * ==========================================================================*/
var CONFIG = {

  // --- WHICH WEEK TO PROCESS -----------------------------------------------
  // 0 = the week containing today (this week's Sunday).
  // 1 = next week (next week's Sunday).  <-- default, for prepping ahead.
  // 2 = two weeks out, etc.
  WEEK_OFFSET: 1,

  // How many days to include starting from that Sunday.
  // 6 = Sunday through Friday (Saturday excluded).
  NUM_DAYS: 6,


  // --- HOW TO IDENTIFY WORK SHIFTS -----------------------------------------
  // Only events on the read-from calendar whose TITLE matches this pattern are
  // treated as work shifts. Typical shift titles look like "Work duty 1075",
  // "Work 0700-1530", "Instructing", etc. We match the whole word "work"
  // (which also covers "Work duty") OR the word "instructing", case-insensitive.
  // The \b word boundaries stop it matching "Network", "Homework", "Workout".
  SHIFT_TITLE_PATTERN: /\b(work|instructing)\b/i,

  // Ignore all-day events (a work shift always has real start/end times).
  IGNORE_ALL_DAY_EVENTS: true,


  // --- HELPER EVENT BLOCKS (THE MODULAR PART) ------------------------------
  // Each entry defines one helper event created for every matched shift.
  // ADD YOUR OWN by copying a block and editing the fields:
  //
  //   title          (required)  Event title. MUST BE UNIQUE across blocks —
  //                              reconcile identifies managed events by title,
  //                              so two blocks sharing a title would collide.
  //   anchor         (required)  'START' or 'END' — which end of the shift the
  //                              offsets are measured from.
  //   startOffsetMin (required)  Minutes from the anchor to the block's START.
  //   endOffsetMin   (required)  Minutes from the anchor to the block's END.
  //                              Must be greater than startOffsetMin.
  //   color          (optional)  One of the fixed EventColor names (see list in
  //                              DEFAULT_EVENT_COLOR). Omit to use the default.
  //   popupReminderMin (optional) Minutes-before pop-up reminder FOR THIS BLOCK.
  //                              Number = add that reminder; null = no reminder;
  //                              omit the field entirely = use DEFAULT_POPUP_
  //                              REMINDER_MIN. This is how each type of time can
  //                              have its own reminder.
  //
  // Example extra block (uncomment to use):
  //   { title: 'Pack bag', anchor: 'START', startOffsetMin: -90, endOffsetMin: -75,
  //     color: 'YELLOW', popupReminderMin: 10 },
  BLOCKS: [
    {
      title: 'Prep lunch',
      anchor: 'START',
      startOffsetMin: -75,
      endOffsetMin: -45,
      color: 'MAUVE',
      popupReminderMin: null
    },
    {
      title: 'Drive to work',
      anchor: 'START',
      startOffsetMin: -45,
      endOffsetMin: 30,
      color: 'MAUVE',
      popupReminderMin: 15
    },
    {
      title: 'Drive from work',
      anchor: 'END',
      startOffsetMin: -45,
      endOffsetMin: 30,
      color: 'MAUVE',
      popupReminderMin: 15
    }
  ],


  // --- DEFAULTS FOR BLOCKS THAT DON'T OVERRIDE -----------------------------
  // Used by any block that omits the matching field.
  // Google Calendar allows only a FIXED set of event colors (no custom hex):
  //   PALE_BLUE, PALE_GREEN, MAUVE, PALE_RED, YELLOW, ORANGE,
  //   CYAN, GRAY, BLUE, GREEN, RED    ('' = the calendar's default color)
  DEFAULT_EVENT_COLOR: 'MAUVE',

  // Minutes-before pop-up used when a block omits popupReminderMin.
  // null = no reminder by default.
  DEFAULT_POPUP_REMINDER_MIN: null,


  // --- DUPLICATE PROTECTION ------------------------------------------------
  // If true, the script will NOT create an event that already exists with the
  // same title AND start time. Safe re-runs. (Reconcile is the primary defense;
  // this is a backstop.)
  SKIP_DUPLICATES: true,


  // --- RECONCILING EVENTS THAT ALREADY EXIST -------------------------------
  // How many minutes an existing event's start/end may differ from the
  // calculated time and still count as "correct". 1 absorbs second-level
  // rounding; use 0 to demand an exact match.
  TIME_MATCH_TOLERANCE_MIN: 1,

  // An existing event is considered "the same booking" as a calculated one
  // when the titles match and both fall on the same calendar day. If its times
  // are wrong it becomes a REPLACE candidate rather than a duplicate.
  // Set false to treat every wrong-timed event as an orphan instead.
  MATCH_BY_SAME_DAY: true,

  // --- LOGGING -------------------------------------------------------------
  // true  = verbose logging (recommended while setting up / troubleshooting).
  // false = quieter logs.
  VERBOSE_LOGGING: true
};
/* ==========================================================================
 * END CONFIG
 * ==========================================================================*/


/* ============================================================================
 * SCRIPT PROPERTY SETUP — run these to manage the calendar IDs/names.
 * ==========================================================================*/

/**
 * ONE-TIME SETUP. Stores the calendar IDs/names in Script Properties.
 *
 * HOW TO USE:
 *   1) Run listAllMyCalendars and copy the ID of the calendar to READ shifts
 *      from (and, if you want, the calendar to WRITE helper events to).
 *   2) Fill in the values below.
 *   3) Run this function once.
 *   4) (Recommended) Blank the values back out and save, so no personal
 *      calendar addresses remain in this file. The stored properties persist.
 *
 * You can also skip this function entirely and set the four keys by hand in
 * Project Settings > Script Properties.
 *
 * Leave a value as '' to leave that property unchanged. Run
 * clearCalendarProperties to blank everything.
 */
function setupCalendarProperties() {
  var values = {};

  // ---- FILL THESE IN, RUN ONCE, THEN BLANK THEM OUT -----------------------
  // Calendar to READ shifts FROM. ID preferred (never changes); name is a
  // fallback used only if the ID is empty.
  values[PROP_KEYS.READ_FROM_CALENDAR_ID] = '';   // e.g. 'someone@gmail.com'
  values[PROP_KEYS.READ_FROM_CALENDAR_NAME] = ''; // e.g. 'Shared Shifts'

  // Calendar to WRITE helper events TO. Leave BOTH empty to use your
  // primary/default calendar (recommended).
  values[PROP_KEYS.WRITE_TO_CALENDAR_ID] = '';
  values[PROP_KEYS.WRITE_TO_CALENDAR_NAME] = '';
  // -------------------------------------------------------------------------

  var props = PropertiesService.getScriptProperties();
  var wrote = 0;
  for (var key in values) {
    var v = values[key];
    if (v !== '') {          // '' means "leave unchanged"
      props.setProperty(key, String(v).trim());
      wrote++;
      log_('Set ' + key + ' = "' + String(v).trim() + '"');
    }
  }
  log_('=== setupCalendarProperties DONE. Wrote ' + wrote + ' propert(ies). ===');
  log_('Reminder: blank the values above and save to keep this file generic.');
  listCalendarProperties();
}

/**
 * Prints the four calendar properties currently stored (for verification).
 */
function listCalendarProperties() {
  log_('=== Stored calendar properties ===');
  for (var name in PROP_KEYS) {
    var key = PROP_KEYS[name];
    var v = getProp_(key);
    log_('  ' + key + ' = ' + (v === '' ? '(empty)' : '"' + v + '"'));
  }
}

/**
 * Deletes all four calendar properties. The main script will then fall back to
 * the primary/default calendar for the write-to and fail to resolve the read-from.
 */
function clearCalendarProperties() {
  var props = PropertiesService.getScriptProperties();
  for (var name in PROP_KEYS) {
    props.deleteProperty(PROP_KEYS[name]);
  }
  log_('=== clearCalendarProperties DONE. All four calendar props removed. ===');
}

/**
 * Reads a Script Property, returning a trimmed string ('' if unset).
 *
 * @param {string} key
 * @return {string}
 */
function getProp_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined) ? '' : String(v).trim();
}


/**
 * DIAGNOSTIC — RUN THIS IF THE SCRIPT CAN'T FIND A CALENDAR.
 * Logs the NAME and ID of every calendar your account can see. Open
 * View > Logs (or the Executions panel) after running to read the list,
 * then copy the desired calendar ID into the READ_FROM_CALENDAR_ID property.
 */
function listAllMyCalendars() {
  log_('=== listAllMyCalendars STARTED ===');
  var calendars = CalendarApp.getAllCalendars();
  log_('Your account can see ' + calendars.length + ' calendar(s):');
  for (var i = 0; i < calendars.length; i++) {
    var c = calendars[i];
    // Printed so you can copy/paste the exact NAME and ID values.
    log_('  [' + (i + 1) + '] NAME: "' + c.getName() + '"');
    log_('        ID  : ' + c.getId());
    log_('        (owned by you? ' + c.isOwnedByMe() + ')');
  }
  log_('=== DONE. Copy the desired ID into the READ_FROM_CALENDAR_ID property. ===');
}


/**
 * DIAGNOSTIC — RUN THIS WHEN THE SCRIPT REPORTS STALE TITLES/TIMES.
 *
 * Symptom this is for: the shifts on the shared calendar were renamed and/or
 * re-timed, but the execution log still shows the OLD titles and OLD times.
 * That means the script is reading a stale COPY of the calendar, not that the
 * block math is wrong. This function prints the evidence needed to tell which
 * copy it is reading:
 *
 *   1) How many calendars match the stored READ_FROM name. If more than one,
 *      resolveCalendar_ silently takes the first — which may be an old
 *      duplicate/copy of the shared calendar.
 *   2) The ID actually resolved, so it can be compared against the ID of the
 *      live shared calendar in listAllMyCalendars.
 *   3) Every raw event in the window with its title, start, end, event ID, and
 *      getLastUpdated() timestamp.
 *
 * HOW TO READ THE RESULT:
 *   - LAST UPDATED is older than when the shifts were edited  -> the calendar
 *     being read is a stale copy. Most common cause: it is an "Other calendars
 *     > From URL" ICS subscription, which Google re-syncs on its own slow
 *     schedule (often many hours, sometimes stuck). Fix by subscribing to the
 *     real shared calendar (Add calendar > Subscribe to calendar) and storing
 *     THAT calendar's ID in READ_FROM_CALENDAR_ID.
 *   - More than one calendar matched the NAME -> name lookup is ambiguous.
 *     Store the correct READ_FROM_CALENDAR_ID so the name is never consulted.
 *   - Titles/times are CURRENT here but shifts were skipped -> the titles no
 *     longer match CONFIG.SHIFT_TITLE_PATTERN; the SHIFT MATCH / SKIP lines
 *     below say which. Widen the pattern.
 *
 * @param {number} [weekOffset] Same meaning as in createAssistEvents.
 */
function diagnoseReadFromCalendar(weekOffset) {
  var offset = (typeof weekOffset === 'number' && isFinite(weekOffset))
             ? weekOffset
             : CONFIG.WEEK_OFFSET;
  log_('=== diagnoseReadFromCalendar STARTED (weekOffset=' + offset + ') ===');

  var storedId = getProp_(PROP_KEYS.READ_FROM_CALENDAR_ID);
  var storedName = getProp_(PROP_KEYS.READ_FROM_CALENDAR_NAME);
  log_('READ_FROM_CALENDAR_ID   = ' + (storedId === '' ? '(empty)' : storedId));
  log_('READ_FROM_CALENDAR_NAME = ' + (storedName === '' ? '(empty)' : storedName));

  // A name that matches several calendars is the classic stale-copy trap.
  if (storedName !== '') {
    var matches = CalendarApp.getCalendarsByName(storedName);
    log_(matches.length + ' calendar(s) match that NAME:');
    for (var m = 0; m < matches.length; m++) {
      log_('  [' + (m + 1) + '] ' + matches[m].getId()
           + (m === 0 ? '   <-- the one name-lookup would pick' : ''));
    }
    if (matches.length > 1) {
      log_('  WARNING: the name is ambiguous. Set READ_FROM_CALENDAR_ID to the');
      log_('           correct ID above so the name is never used.');
    }
  }

  var cal = resolveCalendar_(storedId, storedName, false, 'READ_FROM');
  if (!cal) {
    log_('ERROR: Could not resolve the READ-FROM calendar. Run listAllMyCalendars.');
    return;
  }
  log_('RESOLVED calendar: "' + cal.getName() + '"');
  log_('  id       : ' + cal.getId());
  log_('  owned by me? ' + cal.isOwnedByMe());

  var weekStart = getTargetSunday_(offset);
  var weekEnd = addMinutes_(weekStart, CONFIG.NUM_DAYS * 24 * 60);
  log_('Window: ' + weekStart + '  ->  ' + weekEnd);

  var events = cal.getEvents(weekStart, weekEnd);
  log_('RAW EVENTS IN WINDOW: ' + events.length);

  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    log_('  [' + (i + 1) + '] "' + e.getTitle() + '"');
    log_('        start: ' + e.getStartTime());
    log_('        end  : ' + e.getEndTime());
    log_('        all-day? ' + e.isAllDayEvent()
         + '   recurring? ' + (e.isRecurringEvent ? e.isRecurringEvent() : 'n/a'));
    // The decisive field: when Google last saw a change to this event.
    try {
      log_('        LAST UPDATED: ' + e.getLastUpdated());
    } catch (err) {
      log_('        LAST UPDATED: (unavailable: ' + err + ')');
    }
    log_('        event id: ' + e.getId());
    log_('        matches SHIFT_TITLE_PATTERN? '
         + CONFIG.SHIFT_TITLE_PATTERN.test(e.getTitle()));
  }

  log_('=== DONE. Compare LAST UPDATED against when the shifts were edited. ===');
}


/**
 * MAIN ENTRY POINT.
 * Run this to generate the helper events for the target week.
 *
 * @param {number} [weekOffset] Which week to process:
 *                   0 = this week, 1 = next week, 2 = the week after, etc.
 *                 If omitted, CONFIG.WEEK_OFFSET is used.
 *
 * WHY THE ARGUMENT MIGHT BE IGNORED:
 *   Google Apps Script cannot pass an argument when you (a) pick this function
 *   from the editor's Run menu or (b) fire it from a time-based trigger. In the
 *   trigger case GAS actually passes an EVENT OBJECT as the first argument, not
 *   a number. So this function only trusts weekOffset when it is a real, finite
 *   number; anything else falls back to CONFIG.WEEK_OFFSET.
 *   To target a specific week from a trigger or the Run menu, use one of the
 *   named wrappers below (runForThisWeek / runForNextWeek / ...), or call
 *   runForWeek(n) from your own code.
 */
function createAssistEvents(weekOffset) {
  // Trust the argument only if it is a genuine finite number (see note above).
  var offset = (typeof weekOffset === 'number' && isFinite(weekOffset))
             ? weekOffset
             : CONFIG.WEEK_OFFSET;

  log_('=== createAssistEvents STARTED (weekOffset=' + offset + ') ===');

  // ---- 0) Validate the block definitions before doing anything -----------
  if (!validateBlocks_(CONFIG.BLOCKS)) {
    log_('ERROR: CONFIG.BLOCKS is invalid (see warnings above). Aborting.');
    return;
  }

  // ---- 1) Resolve the READ-FROM calendar (the shifts to read) -------------
  // Tries ID first, then name. Does NOT fall back to your default calendar
  // (we must not accidentally read your own calendar as the shift source).
  var readFromCalendar = resolveCalendar_(getProp_(PROP_KEYS.READ_FROM_CALENDAR_ID),
                                        getProp_(PROP_KEYS.READ_FROM_CALENDAR_NAME),
                                        false, 'READ_FROM');
  if (!readFromCalendar) {
    log_('ERROR: Could not resolve the READ-FROM calendar.');
    log_('       Run listAllMyCalendars, copy the read-from calendar ID, and store it');
    log_('       in the READ_FROM_CALENDAR_ID property (setupCalendarProperties).');
    return;
  }
  log_('Read-from calendar: "' + readFromCalendar.getName() + '" (id: ' + readFromCalendar.getId() + ')');

  // ---- 2) Resolve the WRITE-TO calendar (where we write) ------------------
  // Tries ID, then name, then falls back to your primary/default calendar.
  var writeToCalendar = resolveCalendar_(getProp_(PROP_KEYS.WRITE_TO_CALENDAR_ID),
                                        getProp_(PROP_KEYS.WRITE_TO_CALENDAR_NAME),
                                        true, 'WRITE_TO');
  if (!writeToCalendar) {
    log_('ERROR: Could not resolve the WRITE-TO calendar.');
    return;
  }
  log_('Write-to calendar: "' + writeToCalendar.getName() + '" (id: ' + writeToCalendar.getId() + ')');

  // ---- 3) Work out the date window (target Sunday .. Friday) --------------
  var weekStart = getTargetSunday_(offset); // Sunday 00:00 local
  var weekEnd = addMinutes_(weekStart, CONFIG.NUM_DAYS * 24 * 60); // exclusive end
  log_('Processing window: ' + weekStart + '  ->  ' + weekEnd
       + '  (weekOffset=' + offset + ', NUM_DAYS=' + CONFIG.NUM_DAYS + ')');

  // ---- 4) Pull the read-from events in that window ------------------------
  var allEvents = readFromCalendar.getEvents(weekStart, weekEnd);
  log_('Read-from calendar returned ' + allEvents.length + ' event(s) in the window.');

  // ---- 5) Keep only the ones that look like work shifts -------------------
  var shifts = [];
  for (var i = 0; i < allEvents.length; i++) {
    var ev = allEvents[i];
    var title = ev.getTitle();

    if (CONFIG.IGNORE_ALL_DAY_EVENTS && ev.isAllDayEvent()) {
      log_('  SKIP (all-day): "' + title + '"');
      continue;
    }
    if (!CONFIG.SHIFT_TITLE_PATTERN.test(title)) {
      log_('  SKIP (not a shift): "' + title + '"');
      continue;
    }
    shifts.push(ev);
    log_('  SHIFT MATCH: "' + title + '"  ' + ev.getStartTime() + '  ->  ' + ev.getEndTime());
  }
  log_('Total shifts to process: ' + shifts.length);

  // ---- 6) Work out the helper events each shift SHOULD have ---------------
  var desired = buildDesiredEvents_(shifts);
  log_('Calculated ' + desired.length + ' helper event(s) for this week ('
       + CONFIG.BLOCKS.length + ' block(s) x ' + shifts.length + ' shift(s)).');

  // ---- 7) Read what is ALREADY on the write-to calendar ------------------
  var existing = findAssistEvents_(writeToCalendar, weekStart, weekEnd);
  log_('Found ' + existing.length + ' existing helper event(s) in the window.');

  // ---- 8) Compare the two lists ------------------------------------------
  var plan = reconcile_(desired, existing);
  log_('Reconcile result: ' + plan.correct.length + ' already correct, '
       + plan.wrong.length + ' wrong time, '
       + plan.orphans.length + ' orphaned, '
       + plan.missing.length + ' missing.');

  for (var c = 0; c < plan.correct.length; c++) {
    log_('  OK (correct, leaving alone): ' + describeDesired_(plan.correct[c].desired));
  }

  // ---- 9) Nothing wrong? Create whatever is missing and finish -----------
  if (plan.wrong.length === 0 && plan.orphans.length === 0) {
    if (plan.missing.length === 0) {
      log_('=== DONE. Every helper event already exists with the correct times. Nothing to do. ===');
      return;
    }
    log_('No conflicts. Creating the ' + plan.missing.length + ' missing event(s).');
    var addedOnly = createDesiredEvents_(writeToCalendar, plan.missing);
    log_('=== DONE. Created ' + addedOnly + ' event(s). Deleted 0. ===');
    return;
  }

  // ---- 10) Conflicts exist -> log them, then fix automatically -----------
  logConflicts_(plan, weekStart, weekEnd);

  // ---- 11) Delete the bad events, then write the correct set -------------
  var toDelete = [];
  for (var w = 0; w < plan.wrong.length; w++) { toDelete.push(plan.wrong[w].event); }
  for (var o = 0; o < plan.orphans.length; o++) { toDelete.push(plan.orphans[o]); }

  var deleted = deleteEvents_(toDelete);

  // Everything that was wrong now has to be re-created, plus anything missing.
  var toCreate = plan.missing.slice();
  for (var w2 = 0; w2 < plan.wrong.length; w2++) { toCreate.push(plan.wrong[w2].desired); }

  var created = createDesiredEvents_(writeToCalendar, toCreate);

  log_('=== DONE. Deleted ' + deleted + ' event(s), created ' + created + ' event(s), '
       + 'left ' + plan.correct.length + ' correct event(s) untouched. ===');
}


/* ============================================================================
 * WEEK WRAPPERS — pick one of these when you need a specific week.
 * ----------------------------------------------------------------------------
 * A time-based trigger and the editor's Run menu cannot pass an argument to
 * createAssistEvents, so use these zero-argument wrappers instead. Each one
 * just calls the main function with a fixed week number:
 *     0 = this week      1 = next week (default)
 *     2 = the week after 3 = three weeks out ...
 * Attach any of them to a trigger, or select it from the Run dropdown.
 * From your own code, prefer runForWeek(n) for an arbitrary number.
 * ==========================================================================*/

/** Generic: process the week `n` weeks from now (0 = this week). */
function runForWeek(n) {
  // Coerce so a stray string ("2") still works when called from code; a
  // trigger event object becomes NaN here and the main function then falls
  // back to CONFIG.WEEK_OFFSET, which is the safe default.
  return createAssistEvents(Number(n));
}

/** This week (the week containing today). */
function runForThisWeek() { return createAssistEvents(0); }

/** Next week. This is the default and matches CONFIG.WEEK_OFFSET = 1. */
function runForNextWeek() { return createAssistEvents(1); }

/** Two weeks out (the week after next). */
function runForWeekAfterNext() { return createAssistEvents(2); }

/** Three weeks out. */
function runForThreeWeeksOut() { return createAssistEvents(3); }


/* ============================================================================
 * BLOCK ENGINE — turns CONFIG.BLOCKS + shifts into concrete events.
 * ==========================================================================*/

/**
 * Validates the block list. Logs a warning for each problem found.
 *
 * @param {Object[]} blocks CONFIG.BLOCKS.
 * @return {boolean} true if every block is usable.
 */
function validateBlocks_(blocks) {
  var ok = true;

  if (!blocks || !blocks.length) {
    log_('  BLOCKS problem: the list is empty — nothing would be created.');
    return false;
  }

  var seenTitles = {};
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    var where = 'BLOCKS[' + i + ']';

    if (!b || typeof b.title !== 'string' || b.title.trim() === '') {
      log_('  ' + where + ' problem: missing/blank title.'); ok = false; continue;
    }
    if (seenTitles[b.title]) {
      log_('  ' + where + ' problem: duplicate title "' + b.title
           + '" (titles must be unique — reconcile matches by title).'); ok = false;
    }
    seenTitles[b.title] = true;

    if (b.anchor !== 'START' && b.anchor !== 'END') {
      log_('  ' + where + ' ("' + b.title + '") problem: anchor must be '
           + '\'START\' or \'END\', got ' + JSON.stringify(b.anchor) + '.'); ok = false;
    }
    if (typeof b.startOffsetMin !== 'number' || typeof b.endOffsetMin !== 'number') {
      log_('  ' + where + ' ("' + b.title + '") problem: startOffsetMin and '
           + 'endOffsetMin must both be numbers.'); ok = false;
    } else if (b.endOffsetMin <= b.startOffsetMin) {
      log_('  ' + where + ' ("' + b.title + '") problem: endOffsetMin ('
           + b.endOffsetMin + ') must be greater than startOffsetMin ('
           + b.startOffsetMin + ').'); ok = false;
    }
  }
  return ok;
}

/**
 * The set of titles the script manages, derived from CONFIG.BLOCKS. Only events
 * with one of these titles are ever compared, replaced, or deleted.
 *
 * @return {string[]}
 */
function getManagedTitles_() {
  var titles = [];
  for (var i = 0; i < CONFIG.BLOCKS.length; i++) {
    titles.push(CONFIG.BLOCKS[i].title);
  }
  return titles;
}

/**
 * Resolves the color a block should use: its own override, else the default.
 *
 * @param {Object} block
 * @return {string} An EventColor name, or '' for the calendar default.
 */
function blockColor_(block) {
  return (typeof block.color === 'string') ? block.color : CONFIG.DEFAULT_EVENT_COLOR;
}

/**
 * Resolves the pop-up reminder a block should use.
 *   - a number on the block  -> that many minutes before
 *   - null on the block      -> explicitly no reminder
 *   - field omitted          -> fall back to CONFIG.DEFAULT_POPUP_REMINDER_MIN
 *
 * @param {Object} block
 * @return {number|null}
 */
function blockPopupReminderMin_(block) {
  return block.hasOwnProperty('popupReminderMin')
       ? block.popupReminderMin
       : CONFIG.DEFAULT_POPUP_REMINDER_MIN;
}

/**
 * Turns each work shift into one desired event per block in CONFIG.BLOCKS.
 *
 * @param {CalendarEvent[]} shifts The matched work-shift events.
 * @return {Object[]} Array of desired-event objects:
 *                    {title, start, end, color, popupReminderMin, shiftTitle}.
 */
function buildDesiredEvents_(shifts) {
  var desired = [];

  for (var s = 0; s < shifts.length; s++) {
    var shift = shifts[s];
    var start = shift.getStartTime();
    var end = shift.getEndTime();
    log_('Processing shift ' + (s + 1) + '/' + shifts.length
         + ': "' + shift.getTitle() + '"  START=' + start + '  END=' + end);

    for (var b = 0; b < CONFIG.BLOCKS.length; b++) {
      var block = CONFIG.BLOCKS[b];
      var anchor = (block.anchor === 'END') ? end : start;
      var blockStart = addMinutes_(anchor, block.startOffsetMin);
      var blockEnd = addMinutes_(anchor, block.endOffsetMin);

      desired.push({
        title: block.title,
        start: blockStart,
        end: blockEnd,
        color: blockColor_(block),
        popupReminderMin: blockPopupReminderMin_(block),
        shiftTitle: shift.getTitle()
      });
      log_('    block "' + block.title + '" (' + block.anchor + '): '
           + blockStart + '  ->  ' + blockEnd);
    }
  }

  return desired;
}


/**
 * Returns every event in the window whose title is one the script manages.
 * Events the script did not create are never returned, so they can never be
 * deleted.
 *
 * @param {Calendar} calendar
 * @param {Date}     windowStart
 * @param {Date}     windowEnd
 * @return {CalendarEvent[]}
 */
function findAssistEvents_(calendar, windowStart, windowEnd) {
  var ourTitles = getManagedTitles_();
  var all = calendar.getEvents(windowStart, windowEnd);
  var mine = [];

  for (var i = 0; i < all.length; i++) {
    if (ourTitles.indexOf(all[i].getTitle()) !== -1) {
      mine.push(all[i]);
    }
  }
  return mine;
}


/**
 * Compares the calculated events against what is already on the calendar.
 *
 * Pass 1 claims exact time matches. Pass 2 pairs anything left over by title +
 * same calendar day (closest start time wins), which is what turns a
 * "same event, wrong time" into a REPLACE rather than a delete-plus-duplicate.
 *
 * @param {Object[]}        desired  From buildDesiredEvents_.
 * @param {CalendarEvent[]} existing From findAssistEvents_.
 * @return {Object} {correct:[{event,desired}], wrong:[{event,desired}],
 *                   orphans:[CalendarEvent], missing:[Object]}
 */
function reconcile_(desired, existing) {
  var tolMs = CONFIG.TIME_MATCH_TOLERANCE_MIN * 60 * 1000;
  var claimed = [];      // existing[i] already paired?
  var resolved = [];     // desired[j] already paired?
  var correct = [];
  var wrong = [];

  // ---- Pass 1: exact matches (title + start + end all within tolerance) ---
  for (var j = 0; j < desired.length; j++) {
    for (var i = 0; i < existing.length; i++) {
      if (claimed[i]) { continue; }
      var e = existing[i];
      var d = desired[j];
      if (e.getTitle() !== d.title) { continue; }

      var startsMatch = Math.abs(e.getStartTime().getTime() - d.start.getTime()) <= tolMs;
      var endsMatch = Math.abs(e.getEndTime().getTime() - d.end.getTime()) <= tolMs;

      if (startsMatch && endsMatch) {
        claimed[i] = true;
        resolved[j] = true;
        correct.push({ event: e, desired: d });
        break;
      }
    }
  }

  // ---- Pass 2: same title, same day -> it's the same booking, wrong time --
  if (CONFIG.MATCH_BY_SAME_DAY) {
    for (var j2 = 0; j2 < desired.length; j2++) {
      if (resolved[j2]) { continue; }
      var want = desired[j2];
      var bestIndex = -1;
      var bestGap = Infinity;

      for (var i2 = 0; i2 < existing.length; i2++) {
        if (claimed[i2]) { continue; }
        var cand = existing[i2];
        if (cand.getTitle() !== want.title) { continue; }
        if (!isSameLocalDay_(cand.getStartTime(), want.start)) { continue; }

        // With two shifts on one day, pair the closest start times together.
        var gap = Math.abs(cand.getStartTime().getTime() - want.start.getTime());
        if (gap < bestGap) { bestGap = gap; bestIndex = i2; }
      }

      if (bestIndex !== -1) {
        claimed[bestIndex] = true;
        resolved[j2] = true;
        wrong.push({ event: existing[bestIndex], desired: want });
      }
    }
  }

  // ---- Leftovers ---------------------------------------------------------
  var orphans = [];
  for (var i3 = 0; i3 < existing.length; i3++) {
    if (!claimed[i3]) { orphans.push(existing[i3]); }
  }

  var missing = [];
  for (var j3 = 0; j3 < desired.length; j3++) {
    if (!resolved[j3]) { missing.push(desired[j3]); }
  }

  return { correct: correct, wrong: wrong, orphans: orphans, missing: missing };
}


/**
 * Logs exactly what is about to change, then the caller fixes it
 * automatically. Neither the Apps Script editor nor a time-based trigger can
 * show a dialog, so this is the only record of what happened, not a prompt.
 *
 * @param {Object} plan       From reconcile_.
 * @param {Date}   weekStart
 * @param {Date}   weekEnd
 */
function logConflicts_(plan, weekStart, weekEnd) {
  var message = buildConflictMessage_(plan, weekStart, weekEnd);
  log_('---- CONFLICTS FOUND (fixing automatically) ----');
  log_(message);
  log_('-------------------------------------------------');
}


/**
 * Builds the human-readable log entry describing what will change.
 *
 * @param {Object} plan
 * @param {Date}   weekStart
 * @param {Date}   weekEnd
 * @return {string}
 */
function buildConflictMessage_(plan, weekStart, weekEnd) {
  var lines = [];
  lines.push('Week of ' + fmtDate_(weekStart) + ' - ' + fmtDate_(addMinutes_(weekEnd, -1)) + ':');
  lines.push('');

  if (plan.correct.length > 0) {
    lines.push(plan.correct.length + ' event(s) are already correct and will be left alone.');
    lines.push('');
  }

  if (plan.wrong.length > 0) {
    lines.push('WRONG TIMES (' + plan.wrong.length + ') - would be deleted and re-created:');
    for (var w = 0; w < plan.wrong.length; w++) {
      var e = plan.wrong[w].event;
      var d = plan.wrong[w].desired;
      lines.push('  ' + d.title);
      lines.push('     now: ' + fmtRange_(e.getStartTime(), e.getEndTime()));
      lines.push('     should be: ' + fmtRange_(d.start, d.end));
    }
    lines.push('');
  }

  if (plan.orphans.length > 0) {
    lines.push('NO LONGER NEEDED (' + plan.orphans.length + ') - would be deleted:');
    for (var o = 0; o < plan.orphans.length; o++) {
      var orphan = plan.orphans[o];
      lines.push('  ' + orphan.getTitle() + '  ' + fmtRange_(orphan.getStartTime(), orphan.getEndTime()));
    }
    lines.push('');
  }

  if (plan.missing.length > 0) {
    lines.push('MISSING (' + plan.missing.length + ') - would be created:');
    for (var m = 0; m < plan.missing.length; m++) {
      lines.push('  ' + describeDesired_(plan.missing[m]));
    }
    lines.push('');
  }

  lines.push('Fixing the calendar to match automatically.');
  return lines.join('\n');
}


/**
 * Creates a list of desired events.
 *
 * @param {Calendar} calendar
 * @param {Object[]} list  Desired-event objects from buildDesiredEvents_.
 * @return {number} How many were actually created.
 */
function createDesiredEvents_(calendar, list) {
  var created = 0;
  for (var i = 0; i < list.length; i++) {
    if (createEventSafely_(calendar, list[i])) {
      created++;
    }
  }
  return created;
}


/**
 * Deletes the given events, tolerating individual failures.
 *
 * @param {CalendarEvent[]} events
 * @return {number} How many were deleted.
 */
function deleteEvents_(events) {
  var deleted = 0;
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    try {
      log_('  DELETING: "' + e.getTitle() + '"  ' + fmtRange_(e.getStartTime(), e.getEndTime()));
      e.deleteEvent();
      deleted++;
    } catch (err) {
      log_('  ERROR deleting "' + e.getTitle() + '": ' + err);
    }
  }
  return deleted;
}


/**
 * Resolves a calendar using an ID first, then a name. Optionally falls back to
 * the account's primary/default calendar.
 *
 * @param {string}  id                Calendar ID (preferred). May be '' or null.
 * @param {string}  name              Calendar name (fallback). May be '' or null.
 * @param {boolean} useDefaultIfEmpty If true and neither id nor name resolves,
 *                                    return the primary/default calendar.
 * @param {string}  label             A short label ('READ_FROM'/'WRITE_TO') for logs.
 * @return {Calendar|null} The resolved calendar, or null if nothing matched.
 */
function resolveCalendar_(id, name, useDefaultIfEmpty, label) {
  // 1) Try by ID (most reliable).
  if (id && id.trim() !== '') {
    var byId = CalendarApp.getCalendarById(id.trim());
    if (byId) {
      log_(label + ' resolved by ID.');
      return byId;
    }
    log_('WARNING: ' + label + '_CALENDAR_ID was set but no calendar matched that ID.');
  }

  // 2) Try by name.
  if (name && name.trim() !== '') {
    var byName = CalendarApp.getCalendarsByName(name.trim());
    if (byName && byName.length > 0) {
      log_(label + ' resolved by NAME.');
      return byName[0];
    }
    log_('WARNING: ' + label + '_CALENDAR_NAME "' + name + '" did not match any calendar.');
  }

  // 3) Optional fallback to the primary/default calendar.
  if (useDefaultIfEmpty) {
    log_(label + ' falling back to your primary/default calendar.');
    return CalendarApp.getDefaultCalendar();
  }

  return null;
}


/**
 * Creates a single event on the given calendar from a desired-event object,
 * honoring its per-block color and reminder plus CONFIG duplicate protection.
 *
 * @param {Calendar} calendar The write-to CalendarApp calendar object.
 * @param {Object}   desired  {title, start, end, color, popupReminderMin}.
 * @return {boolean} true if an event was created, false if skipped.
 */
function createEventSafely_(calendar, desired) {
  var title = desired.title;
  var startTime = desired.start;
  var endTime = desired.end;

  // ---- Duplicate check ----
  if (CONFIG.SKIP_DUPLICATES && eventExists_(calendar, title, startTime)) {
    log_('    SKIP (duplicate exists): "' + title + '" @ ' + startTime);
    return false;
  }

  // ---- Create the event ----
  try {
    var event = calendar.createEvent(title, startTime, endTime);
    log_('    CREATED: "' + title + '"  ' + startTime + '  ->  ' + endTime);

    // ---- Apply color (per-block override or default; '' leaves default) ----
    var color = desired.color;
    if (color && color.trim() !== '') {
      if (CalendarApp.EventColor[color]) {
        event.setColor(CalendarApp.EventColor[color]);
        log_('      color set to ' + color);
      } else {
        log_('      WARNING: "' + color + '" is not a valid EventColor; leaving default.');
      }
    }

    // ---- Apply pop-up reminder (per-block; null/undefined = none) ----
    var reminder = desired.popupReminderMin;
    if (reminder !== null && reminder !== undefined) {
      event.addPopupReminder(reminder);
      log_('      popup reminder set to ' + reminder + ' min before');
    }

    return true;
  } catch (err) {
    log_('    ERROR creating "' + title + '": ' + err);
    return false;
  }
}


/**
 * Returns true if an event with the same title AND the same start time already
 * exists on the calendar (checked within a small window around the start time).
 *
 * @param {Calendar} calendar
 * @param {string}   title
 * @param {Date}     startTime
 * @return {boolean}
 */
function eventExists_(calendar, title, startTime) {
  // Look one minute either side of the intended start to catch exact matches.
  var windowStart = addMinutes_(startTime, -1);
  var windowEnd = addMinutes_(startTime, 1);
  var existing = calendar.getEvents(windowStart, windowEnd);

  for (var i = 0; i < existing.length; i++) {
    var e = existing[i];
    // Compare titles and start-time to the minute.
    if (e.getTitle() === title
        && Math.abs(e.getStartTime().getTime() - startTime.getTime()) < 60 * 1000) {
      return true;
    }
  }
  return false;
}


/**
 * OPTIONAL CLEANUP.
 * Deletes events THIS SCRIPT creates (matching the configured block titles)
 * inside the target week window. Use this if you want a clean redo after
 * changing timing rules. Non-matching events are never touched.
 *
 * @param {number} [weekOffset] Same meaning as in createAssistEvents
 *                 (0 = this week, 1 = next week, ...). Omitted / non-number
 *                 (e.g. a trigger event object) falls back to CONFIG.WEEK_OFFSET.
 */
function deleteAssistEventsInTargetWeek(weekOffset) {
  var offset = (typeof weekOffset === 'number' && isFinite(weekOffset))
             ? weekOffset
             : CONFIG.WEEK_OFFSET;
  log_('=== deleteAssistEventsInTargetWeek STARTED (weekOffset=' + offset + ') ===');

  // Resolve the same write-to calendar the creator writes to.
  var writeToCalendar = resolveCalendar_(getProp_(PROP_KEYS.WRITE_TO_CALENDAR_ID),
                                        getProp_(PROP_KEYS.WRITE_TO_CALENDAR_NAME),
                                        true, 'WRITE_TO');
  if (!writeToCalendar) {
    log_('ERROR: Could not resolve the WRITE-TO calendar.');
    return;
  }

  var weekStart = getTargetSunday_(offset);
  var weekEnd = addMinutes_(weekStart, CONFIG.NUM_DAYS * 24 * 60);
  log_('Delete window: ' + weekStart + '  ->  ' + weekEnd);

  var titlesToDelete = getManagedTitles_();
  var events = writeToCalendar.getEvents(weekStart, weekEnd);
  var deleted = 0;

  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (titlesToDelete.indexOf(e.getTitle()) !== -1) {
      log_('  DELETING: "' + e.getTitle() + '"  ' + e.getStartTime());
      e.deleteEvent();
      deleted++;
    }
  }
  log_('=== DONE. Deleted ' + deleted + ' event(s). ===');
}


/**
 * OPTIONAL AUTOMATION.
 * Installs a weekly time-based trigger, every Friday at ~5 PM.
 *
 * A trigger cannot pass an argument, so it is pointed at one of the named week
 * wrappers instead of the main function. By default that is runForNextWeek
 * (prep the upcoming week). Pass a different handler name to target another
 * week, e.g. installWeeklyTrigger('runForWeekAfterNext').
 *
 * Running this more than once will NOT stack triggers — it first clears any
 * existing trigger pointing at the main function or any week wrapper.
 *
 * @param {string} [handlerName] One of: 'runForThisWeek', 'runForNextWeek',
 *                 'runForWeekAfterNext', 'runForThreeWeeksOut'. Default
 *                 'runForNextWeek'.
 */
function installWeeklyTrigger(handlerName) {
  log_('=== installWeeklyTrigger STARTED ===');

  var handler = handlerName || 'runForNextWeek';

  // Only these are valid trigger targets. Reject anything else so a typo does
  // not silently install a trigger for a non-existent function.
  var allowed = ['runForThisWeek', 'runForNextWeek', 'runForWeekAfterNext',
                 'runForThreeWeeksOut', 'createAssistEvents'];
  if (allowed.indexOf(handler) === -1) {
    log_('ERROR: "' + handler + '" is not an installable handler. Choose one of: '
         + allowed.join(', '));
    return;
  }

  // Remove any existing trigger pointing at our main function OR any wrapper,
  // so re-running never stacks duplicates and switching weeks replaces cleanly.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (allowed.indexOf(triggers[i].getHandlerFunction()) !== -1) {
      log_('  Removed an existing trigger for ' + triggers[i].getHandlerFunction() + '.');
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create a fresh weekly trigger: Fridays around 5 PM.
  ScriptApp.newTrigger(handler)
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(17) // 24-hour clock; 17 = 5 PM in the script's time zone.
    .create();

  log_('  Installed weekly trigger: Fridays ~5 PM -> ' + handler + '().');
  log_('=== DONE. ===');
}


/* ============================================================================
 * SMALL HELPER FUNCTIONS
 * ==========================================================================*/

/**
 * Returns the Sunday (at 00:00 local time) of the week that is `offsetWeeks`
 * weeks away from today.
 *   offsetWeeks = 0  -> this week's Sunday
 *   offsetWeeks = 1  -> next week's Sunday
 *
 * @param {number} offsetWeeks
 * @return {Date} Sunday at midnight local time.
 */
function getTargetSunday_(offsetWeeks) {
  var today = new Date();

  // getDay(): 0=Sun, 1=Mon, ... 6=Sat. Subtract that many days to reach
  // THIS week's Sunday, then add the requested number of whole weeks.
  var sunday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  sunday.setDate(sunday.getDate() - today.getDay() + (offsetWeeks * 7));
  sunday.setHours(0, 0, 0, 0);
  return sunday;
}

/**
 * Returns a NEW Date offset from the given date by the specified minutes.
 * Positive minutes move forward in time; negative moves backward.
 *
 * @param {Date}   date
 * @param {number} minutes
 * @return {Date}
 */
function addMinutes_(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/**
 * True when both dates fall on the same calendar day in local time.
 *
 * @param {Date} a
 * @param {Date} b
 * @return {boolean}
 */
function isSameLocalDay_(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
}

/**
 * Formats a date as "Mon Jul 27" in the script's time zone.
 *
 * @param {Date} d
 * @return {string}
 */
function fmtDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'EEE MMM d');
}

/**
 * Formats a start/end pair as "Mon Jul 27  6:45 AM - 8:00 AM".
 *
 * @param {Date} start
 * @param {Date} end
 * @return {string}
 */
function fmtRange_(start, end) {
  var tz = Session.getScriptTimeZone();
  return Utilities.formatDate(start, tz, 'EEE MMM d  h:mm a')
       + ' - ' + Utilities.formatDate(end, tz, 'h:mm a');
}

/**
 * One-line description of a desired event, for logs and dialogs.
 *
 * @param {Object} d Desired-event object with {title, start, end}.
 * @return {string}
 */
function describeDesired_(d) {
  return d.title + '  ' + fmtRange_(d.start, d.end);
}

/**
 * Central logging helper. Respects CONFIG.VERBOSE_LOGGING for indented detail
 * lines, but always logs top-level (non-indented) status lines.
 *
 * @param {string} message
 */
function log_(message) {
  var isDetailLine = message.indexOf('  ') === 0; // starts with indentation
  if (CONFIG.VERBOSE_LOGGING || !isDetailLine) {
    Logger.log(message);
  }
}

/**
 * ============================================================================
 * END OF FILE: CalendarAssistScheduler.gs
 * ============================================================================
 */

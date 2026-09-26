/**
 * ============================================================================
 * FILE: CalendarAssistScheduler.gs
 * Version: 3.6 | Updated: 2026-09-25
 *   v3.6: Eve mirrors are now DURATION_MIN (15) long instead of the in-game
 *   duration, use the calendar's default color (COLOR ''), and resetEveMirrors()
 *   was added to re-create existing ones with the new color.
 *   v3.5: adds the Eve "Mining" mirror. Deviations from the request: a timed
 *   calendar event instead of a Google Task (Tasks drop the time), read via Eve
 *   ESI polled hourly instead of a Google calendar-updated trigger (the in-game
 *   calendar has no Google feed).
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
 *   Before writing anything, the script reads the write-to calendar over the
 *   target week PLUS a padding margin (wide enough to cover the biggest block
 *   offset, e.g. a block that starts 75 minutes before an early-Sunday shift
 *   lands on Saturday) and compares any existing managed events (those whose
 *   title is one of the block titles) against the times it just calculated:
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
 *   esiSetupProperties            - store Eve ESI client id/secret (run once).
 *   esiLogAuthUrl                 - print the Eve SSO login URL (one-time auth).
 *   esiStoreAuthCode              - swap the pasted auth code for a refresh token.
 *   syncEveMiningEvents           - mirror upcoming Eve in-game calendar items whose
 *                                   title contains "Mining" onto the write-to calendar
 *                                   as timed events (in-game start, DURATION_MIN long).
 *   installEveMiningTrigger       - run syncEveMiningEvents on an hourly poll.
 *   resetEveMirrors               - delete future Eve mirrors + forget them, so the
 *                                   next sync re-creates them (e.g. after a color change).
 *
 * EVE MINING MIRROR (v3.5):
 *   The in-game calendar has no Google feed, so the script reads it from Eve's ESI
 *   API (scope esi-calendar.read_calendar_events.v1) using a refresh token stored in
 *   Script Properties ESI_CLIENT_ID / ESI_CLIENT_SECRET / ESI_REFRESH_TOKEN.
 *   Google Tasks only store a due DATE (time is dropped), so instead of a Task the
 *   script creates a timed calendar event at the in-game time. Each mirror carries
 *   a "EVE_SRC:<eve event id>" marker in its description so re-runs never
 *   duplicate. A re-timed in-game item re-times its mirror; an item that
 *   disappears from the in-game list has its future mirror deleted; a mirror you
 *   delete by hand is NOT recreated (ids remembered in ESI_MIRRORED_IDS).
 *   ESI has no push, so detection is an hourly poll, not a calendar trigger. If
 *   ESI auth fails the run throws, so enable failure notifications on the trigger
 *   (Apps Script > Triggers > Failure notification settings).
 *   Mirror titles are prefixed (CONFIG.EVE_MINING.EVENT_TITLE_PREFIX) so they can
 *   never collide with CONFIG.BLOCKS titles that reconcile manages/deletes.
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

// Eve ESI credentials. Kept OUT of PROP_KEYS on purpose so clearCalendarProperties
// (which loops PROP_KEYS) can never wipe the stored refresh token.
var ESI_PROP_KEYS = {
  CLIENT_ID: 'ESI_CLIENT_ID',
  CLIENT_SECRET: 'ESI_CLIENT_SECRET',
  REFRESH_TOKEN: 'ESI_REFRESH_TOKEN',
  // JSON array of Eve event ids already mirrored (so a hand-deleted mirror is
  // not recreated). Written by syncEveMiningEvents; safe to delete to reset.
  MIRRORED_IDS: 'ESI_MIRRORED_IDS'
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

  // --- EVE ONLINE MINING MIRROR --------------------------------------------
  // In-game Eve calendar items (read via ESI) whose title matches TITLE_PATTERN
  // are copied onto the write-to calendar at the same start/end (see
  // syncEveMiningEvents).
  EVE_MINING: {
    TITLE_PATTERN: /\bmining\b/i,
    // ESI owner_type values to accept. 'corporation' = corp calendar items only.
    // Add 'alliance', 'character', etc. to widen. Rejected types are logged.
    OWNER_TYPES: ['corporation'],
    // Length (min) of every mirrored event, starting at the in-game time. The
    // in-game duration is ignored.
    DURATION_MIN: 15,
    // Max ESI list pages (50 events each) fetched per run.
    MAX_PAGES: 10,
    // Seconds an item's ESI detail (duration/owner/text) is cached, so the
    // hourly poll doesn't re-fetch every Mining item. Max 21600 (6 h).
    DETAIL_CACHE_SEC: 21600,
    // Prefix on the mirrored event title. MUST NOT make a title equal to any
    // CONFIG.BLOCKS title (reconcile deletes managed titles).
    EVENT_TITLE_PREFIX: 'Eve: ',
    // How many days ahead of now to scan for Mining items.
    SCAN_DAYS: 60,
    // '' = the calendar's own default color (the "same green" as the rest of the
    // calendar). Set an EventColor name (e.g. 'GREEN', 'PALE_GREEN') to force one.
    COLOR: '',
    // Minutes-before pop-up; null = none.
    POPUP_REMINDER_MIN: 15,
    // Description marker used to recognise an already-mirrored source event.
    MARKER_PREFIX: 'EVE_SRC:',
    // Poll interval (hours) installed by installEveMiningTrigger.
    POLL_EVERY_HOURS: 1
  },


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
  var offset = resolveWeekOffset_(weekOffset);
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

  var window = getWeekWindow_(offset);
  log_('Window: ' + window.start + '  ->  ' + window.end);

  var events = cal.getEvents(window.start, window.end);
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
  var offset = resolveWeekOffset_(weekOffset);

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
  var window = getWeekWindow_(offset); // {start, end, scanStart, scanEnd}
  var weekStart = window.start; // Sunday 00:00 local
  var weekEnd = window.end; // exclusive end
  log_('Processing window: ' + weekStart + '  ->  ' + weekEnd
       + '  (weekOffset=' + offset + ', NUM_DAYS=' + CONFIG.NUM_DAYS + ')');
  log_('Reconcile scan window (padded for out-of-week block offsets): '
       + window.scanStart + '  ->  ' + window.scanEnd);

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

  // ---- 7) Read what is ALREADY on the write-to calendar -------------------
  // Scanned over the padded window (see getWeekWindow_), not just weekStart..
  // weekEnd: a block anchored far enough from its shift's START/END can land
  // outside the shift week (e.g. "Prep lunch" 75 min before an early-Sunday
  // shift falls on Saturday). Scanning only the shift week would report that
  // existing event as "missing" forever and could never mark it an orphan.
  var existing = findAssistEvents_(writeToCalendar, window.scanStart, window.scanEnd);
  log_('Found ' + existing.length + ' existing helper event(s) in the scan window.');

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
function runForWeek(n=0) {
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

    // Catch a bad color/reminder here, before any events are written — left
    // unchecked, a typo'd color only surfaces as a per-event WARNING at
    // creation time (after some events already exist), and a non-numeric
    // popupReminderMin throws inside addPopupReminder_, silently dropping
    // just that one event's reminder.
    if (b.hasOwnProperty('color') && b.color !== undefined
        && typeof b.color === 'string' && b.color.trim() !== ''
        && !CalendarApp.EventColor[b.color]) {
      log_('  ' + where + ' ("' + b.title + '") problem: color "' + b.color
           + '" is not a valid EventColor name.'); ok = false;
    }
    if (b.hasOwnProperty('popupReminderMin') && b.popupReminderMin !== null
        && typeof b.popupReminderMin !== 'number') {
      log_('  ' + where + ' ("' + b.title + '") problem: popupReminderMin must '
           + 'be a number or null, got ' + JSON.stringify(b.popupReminderMin)
           + '.'); ok = false;
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
  var offset = resolveWeekOffset_(weekOffset);
  log_('=== deleteAssistEventsInTargetWeek STARTED (weekOffset=' + offset + ') ===');

  // Resolve the same write-to calendar the creator writes to.
  var writeToCalendar = resolveCalendar_(getProp_(PROP_KEYS.WRITE_TO_CALENDAR_ID),
                                        getProp_(PROP_KEYS.WRITE_TO_CALENDAR_NAME),
                                        true, 'WRITE_TO');
  if (!writeToCalendar) {
    log_('ERROR: Could not resolve the WRITE-TO calendar.');
    return;
  }

  // Padded scan window, same reasoning as createAssistEvents: a block anchored
  // far enough from its shift's START/END can land just outside the shift week.
  var window = getWeekWindow_(offset);
  log_('Delete window: ' + window.scanStart + '  ->  ' + window.scanEnd);

  var toDelete = findAssistEvents_(writeToCalendar, window.scanStart, window.scanEnd);
  var deleted = deleteEvents_(toDelete);
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
 * EVE MINING MIRROR — copies "Mining" in-game calendar items (via Eve ESI) to the
 * write-to calendar as timed events.
 * ==========================================================================*/

var ESI_BASE_ = 'https://esi.evetech.net/latest';
var ESI_TOKEN_URL_ = 'https://login.eveonline.com/v2/oauth/token';
var ESI_AUTH_URL_ = 'https://login.eveonline.com/v2/oauth/authorize';
var ESI_SCOPE_ = 'esi-calendar.read_calendar_events.v1';
// Must exactly match the Callback URL registered on the Eve developer app.
var ESI_REDIRECT_URI_ = 'https://localhost/callback';
var ESI_TOKEN_CACHE_KEY_ = 'ESI_ACCESS_TOKEN';


/**
 * ONE-TIME SETUP. Stores the Eve developer app's client id/secret in Script
 * Properties. Fill in, run once, then blank the values back out and save.
 * Leave a value as '' to leave that property unchanged.
 *
 * Create the app at https://developers.eveonline.com/ (Applications > Create):
 * scope esi-calendar.read_calendar_events.v1, callback URL
 * https://localhost/callback.
 */
function esiSetupProperties() {
  log_('esiSetupProperties start');
  var values = {};
  // ---- FILL THESE IN, RUN ONCE, THEN BLANK THEM OUT -----------------------
  values[ESI_PROP_KEYS.CLIENT_ID] = '';
  values[ESI_PROP_KEYS.CLIENT_SECRET] = '';
  // -------------------------------------------------------------------------
  var props = PropertiesService.getScriptProperties();
  var wrote = 0;
  for (var key in values) {
    if (values[key] !== '') {
      props.setProperty(key, String(values[key]).trim());
      wrote++;
      log_('  Set ' + key + ' (value not logged).');
    }
  }
  log_('esiSetupProperties end: wrote ' + wrote + ' propert(ies). '
       + 'Client id set? ' + (getProp_(ESI_PROP_KEYS.CLIENT_ID) !== '')
       + ', secret set? ' + (getProp_(ESI_PROP_KEYS.CLIENT_SECRET) !== '')
       + ', refresh token set? ' + (getProp_(ESI_PROP_KEYS.REFRESH_TOKEN) !== '') + '.');
}


/**
 * ONE-TIME AUTH, STEP 1. Logs the Eve SSO login URL. Open it, log in as the
 * character that can see the corp calendar, approve, then copy the `code=`
 * value from the (failed-to-load) https://localhost/callback?code=... address.
 */
function esiLogAuthUrl() {
  log_('esiLogAuthUrl start');
  var clientId = getProp_(ESI_PROP_KEYS.CLIENT_ID);
  if (clientId === '') {
    log_('ERROR: ESI_CLIENT_ID is not set. Run esiSetupProperties first. esiLogAuthUrl end (aborted).');
    return;
  }
  var url = ESI_AUTH_URL_ + '?response_type=code'
          + '&redirect_uri=' + encodeURIComponent(ESI_REDIRECT_URI_)
          + '&client_id=' + encodeURIComponent(clientId)
          + '&scope=' + encodeURIComponent(ESI_SCOPE_)
          + '&state=calendar-assist';
  log_('Open this URL in a browser and log in:');
  log_(url);
  log_('esiLogAuthUrl end: URL logged for client id ending "'
       + clientId.slice(-4) + '".');
}


/**
 * ONE-TIME AUTH, STEP 2. Paste the `code` from the callback address below, run
 * once, then blank it out. Exchanges it for a long-lived refresh token stored in
 * ESI_REFRESH_TOKEN. The code is single-use and expires in minutes.
 */
function esiStoreAuthCode() {
  // ---- PASTE THE CODE HERE, RUN ONCE, THEN BLANK IT OUT --------------------
  var code = '';
  // -------------------------------------------------------------------------
  log_('esiStoreAuthCode start');
  if (code.trim() === '') {
    log_('ERROR: paste the auth code into `code` first. esiStoreAuthCode end (aborted).');
    return;
  }
  var body = esiTokenRequest_({ grant_type: 'authorization_code', code: code.trim() });
  if (!body || !body.refresh_token) {
    log_('ERROR: token exchange failed (see above). esiStoreAuthCode end (aborted).');
    return;
  }
  PropertiesService.getScriptProperties().setProperty(ESI_PROP_KEYS.REFRESH_TOKEN, body.refresh_token);
  CacheService.getScriptCache().put(ESI_TOKEN_CACHE_KEY_, body.access_token, 1100);
  log_('esiStoreAuthCode end: refresh token stored, character '
       + esiCharacterIdFromToken_(body.access_token) + '. Blank the `code` value now.');
}


/**
 * POSTs to the Eve SSO token endpoint with the app's client id/secret.
 *
 * @param {Object} payload Form fields (grant_type + code/refresh_token).
 * @return {Object|null} Parsed token response, or null on failure.
 */
function esiTokenRequest_(payload) {
  log_('esiTokenRequest_ start: grant_type=' + payload.grant_type);
  var id = getProp_(ESI_PROP_KEYS.CLIENT_ID);
  var secret = getProp_(ESI_PROP_KEYS.CLIENT_SECRET);
  if (id === '' || secret === '') {
    log_('ERROR: ESI_CLIENT_ID / ESI_CLIENT_SECRET not set. Run esiSetupProperties. '
         + 'esiTokenRequest_ end: null (credentials missing).');
    return null;
  }
  var res = UrlFetchApp.fetch(ESI_TOKEN_URL_, {
    method: 'post',
    payload: payload,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(id + ':' + secret) },
    muteHttpExceptions: true
  });
  var status = res.getResponseCode();
  if (status !== 200) {
    log_('ERROR: SSO token request (' + payload.grant_type + ') returned HTTP '
         + status + ': ' + res.getContentText().substring(0, 300)
         + '. esiTokenRequest_ end: null.');
    return null;
  }
  var body = JSON.parse(res.getContentText());
  log_('esiTokenRequest_ end: OK, expires_in=' + body.expires_in
       + ', refresh token returned? ' + !!body.refresh_token);
  return body;
}


/**
 * Returns a valid ESI access token, using the cached one (~19 min life) when
 * present, else refreshing with the stored refresh token. If SSO rotates the
 * refresh token, the new one is stored. A cached token that ESI rejects (401)
 * is dropped by esiGet_, so the next call refreshes.
 *
 * @return {string|null} Access token, or null if unavailable.
 */
function esiGetAccessToken_() {
  log_('esiGetAccessToken_ start');
  var cached = CacheService.getScriptCache().get(ESI_TOKEN_CACHE_KEY_);
  if (cached) {
    log_('esiGetAccessToken_ end: cache hit.');
    return cached;
  }
  var refresh = getProp_(ESI_PROP_KEYS.REFRESH_TOKEN);
  if (refresh === '') {
    log_('ERROR: ESI_REFRESH_TOKEN not set. Run esiLogAuthUrl then esiStoreAuthCode. '
         + 'esiGetAccessToken_ end: null.');
    return null;
  }
  log_('  cache miss, refreshing.');
  var body = esiTokenRequest_({ grant_type: 'refresh_token', refresh_token: refresh });
  if (!body || !body.access_token) {
    log_('esiGetAccessToken_ end: null (refresh failed).');
    return null;
  }
  if (body.refresh_token && body.refresh_token !== refresh) {
    PropertiesService.getScriptProperties().setProperty(ESI_PROP_KEYS.REFRESH_TOKEN, body.refresh_token);
    log_('  refresh token rotated and stored.');
  }
  CacheService.getScriptCache().put(ESI_TOKEN_CACHE_KEY_, body.access_token, 1100);
  log_('esiGetAccessToken_ end: refreshed and cached.');
  return body.access_token;
}


/**
 * Reads the character id from an ESI access token (a JWT whose `sub` is
 * "CHARACTER:EVE:<id>").
 *
 * @param {string} token
 * @return {string} Character id, or '' if unparsable.
 */
function esiCharacterIdFromToken_(token) {
  log_('esiCharacterIdFromToken_ start');
  try {
    var payload = token.split('.')[1];
    var json = Utilities.newBlob(Utilities.base64DecodeWebSafe(payload)).getDataAsString();
    var sub = JSON.parse(json).sub || '';
    var id = sub.split(':')[2] || '';
    log_('esiCharacterIdFromToken_ end: ' + (id === '' ? '(empty, sub="' + sub + '")' : id));
    return id;
  } catch (err) {
    log_('ERROR: could not read character id from token: ' + err
         + '. esiCharacterIdFromToken_ end: (empty).');
    return '';
  }
}


/**
 * GETs an ESI path with the bearer token and parses the JSON. Retries up to 3
 * attempts on 420/429/5xx (ESI rate/error limits) with a growing pause. A 401
 * drops the cached access token so the next run refreshes it.
 *
 * @param {string} path  e.g. '/characters/123/calendar/'.
 * @param {string} token
 * @return {*|null} Parsed JSON, or null on failure.
 */
function esiGet_(path, token) {
  log_('esiGet_ start: ' + path);
  var maxAttempts = 3;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    var res = UrlFetchApp.fetch(ESI_BASE_ + path, {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    var status = res.getResponseCode();
    if (status === 200) {
      log_('esiGet_ end: HTTP 200 (attempt ' + attempt + ').');
      return JSON.parse(res.getContentText());
    }
    if (status === 401) {
      CacheService.getScriptCache().remove(ESI_TOKEN_CACHE_KEY_);
      log_('ERROR: ESI GET ' + path + ' returned 401; cleared the cached access token. '
           + 'esiGet_ end: null.');
      return null;
    }
    if ((status === 420 || status === 429 || status >= 500) && attempt < maxAttempts) {
      var waitMs = 2000 * attempt;
      log_('  HTTP ' + status + ' on attempt ' + attempt + '; retrying in ' + waitMs + ' ms.');
      Utilities.sleep(waitMs);
      continue;
    }
    log_('ERROR: ESI GET ' + path + ' returned HTTP ' + status + ' (attempt ' + attempt + '): '
         + res.getContentText().substring(0, 300) + '. esiGet_ end: null.');
    return null;
  }
  return null;
}


/**
 * Returns the detail (title, duration, owner_type, text) for a calendar item,
 * cached per event id for CONFIG.EVE_MINING.DETAIL_CACHE_SEC so the hourly poll
 * does not re-fetch every Mining item. A cache entry is only trusted while the
 * list summary's date AND title still match what was cached; if either changed,
 * the detail is re-fetched.
 *
 * @param {string} charId
 * @param {Object} summary  One entry from the ESI calendar list.
 * @param {string} token
 * @return {Object|null} {title, text, duration, owner_type}, or null on failure.
 */
function esiGetEventDetail_(charId, summary, token) {
  var cfg = CONFIG.EVE_MINING;
  var key = 'ESI_EVT_' + summary.event_id;
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) {
    var c = JSON.parse(hit);
    if (c.event_date === summary.event_date && c.title === summary.title) {
      log_('  detail cache hit: event ' + summary.event_id);
      return c.detail;
    }
    log_('  detail cache stale (date/title changed): event ' + summary.event_id);
  }
  var d = esiGet_('/characters/' + charId + '/calendar/' + summary.event_id + '/', token);
  if (d === null) { return null; }
  var detail = {
    title: d.title || summary.title,
    text: (d.text || '').substring(0, 2000),
    duration: d.duration,
    owner_type: d.owner_type
  };
  cache.put(key, JSON.stringify({
    event_date: summary.event_date, title: summary.title, detail: detail
  }), cfg.DETAIL_CACHE_SEC);
  return detail;
}


/**
 * Fetches upcoming in-game calendar items that match the Mining title pattern and
 * owner types, as normalized objects.
 *
 * ESI lists up to 50 summaries per page; later pages are requested with
 * from_event=<last event id>. Items are NOT assumed to be date-ordered: every
 * page is read (up to CONFIG.EVE_MINING.MAX_PAGES) and out-of-window items are
 * skipped individually. Repeated ids across pages are ignored.
 *
 * @param {string} token
 * @param {Date}   windowEnd Items dated after this are ignored.
 * @return {{items:Object[], complete:boolean}|null} items = [{id, title, start,
 *         end, text}]. complete=false when MAX_PAGES cut the scan short (so
 *         absence of an item proves nothing). null on ESI failure.
 */
function fetchEveMiningItems_(token, windowEnd) {
  var cfg = CONFIG.EVE_MINING;
  var charId = esiCharacterIdFromToken_(token);
  log_('fetchEveMiningItems_ start: character=' + charId + ', windowEnd=' + windowEnd
       + ', maxPages=' + cfg.MAX_PAGES);
  if (charId === '') {
    log_('fetchEveMiningItems_ end: null (no character id).');
    return null;
  }

  var items = [];
  var seen = {};
  var fromEvent = null;
  var listed = 0, titleMatches = 0, outOfWindow = 0, wrongOwner = 0;
  var exhausted = false;

  for (var page = 0; page < cfg.MAX_PAGES; page++) {
    var path = '/characters/' + charId + '/calendar/' + (fromEvent ? '?from_event=' + fromEvent : '');
    var list = esiGet_(path, token);
    if (list === null) {
      log_('fetchEveMiningItems_ end: null (list request failed on page ' + (page + 1) + ').');
      return null;
    }
    log_('  page ' + (page + 1) + ': ' + list.length + ' event summar(ies).');

    var fresh = 0;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (seen[s.event_id]) { continue; }
      seen[s.event_id] = true;
      fresh++;
      listed++;

      var date = new Date(s.event_date);
      if (date.getTime() > windowEnd.getTime()) {
        log_('  SKIP (after window): "' + s.title + '" ' + s.event_date);
        outOfWindow++;
        continue;
      }
      if (!cfg.TITLE_PATTERN.test(s.title || '')) {
        log_('  SKIP (no "mining" match): "' + s.title + '" ' + s.event_date);
        continue;
      }
      titleMatches++;

      var d = esiGetEventDetail_(charId, s, token);
      if (d === null) {
        log_('fetchEveMiningItems_ end: null (detail failed for event ' + s.event_id + ').');
        return null;
      }
      if (cfg.OWNER_TYPES.indexOf(d.owner_type) === -1) {
        log_('  SKIP (owner_type "' + d.owner_type + '" not in ' + JSON.stringify(cfg.OWNER_TYPES)
             + '): "' + s.title + '" ' + s.event_date);
        wrongOwner++;
        continue;
      }
      // Mirror length is fixed by config; the in-game duration (d.duration) is
      // deliberately ignored so every mirror is a short reminder block.
      var durationMin = cfg.DURATION_MIN;
      var item = {
        id: String(s.event_id),
        title: d.title,
        start: date,
        end: addMinutes_(date, durationMin),
        text: d.text
      };
      items.push(item);
      log_('  ACCEPT: id=' + item.id + ' "' + item.title + '" ' + fmtRange_(item.start, item.end)
           + ' (' + durationMin + ' min)');
    }

    // A short page, an empty page, or a page with nothing new means the list ended.
    if (list.length < 50 || fresh === 0) { exhausted = true; break; }
    fromEvent = list[list.length - 1].event_id;
  }

  if (!exhausted) {
    log_('WARNING: hit MAX_PAGES (' + cfg.MAX_PAGES + ') with more pages available; '
         + 'later items were NOT read. Raise CONFIG.EVE_MINING.MAX_PAGES if needed.');
  }
  log_('fetchEveMiningItems_ end: listed ' + listed + ', title matches ' + titleMatches
       + ', after window ' + outOfWindow + ', wrong owner ' + wrongOwner
       + ', accepted ' + items.length + ', complete=' + exhausted + '.');
  return { items: items, complete: exhausted };
}


/**
 * ENTRY POINT (trigger-safe, zero-arg). Keeps the write-to calendar's Eve
 * mirrors in step with the in-game calendar:
 *   - new Mining item                  -> mirror created (in-game start + DURATION_MIN)
 *   - mirrored item moved/re-timed     -> existing mirror re-timed (no duplicate)
 *   - mirror deleted by hand           -> NOT recreated (id remembered in
 *                                         ESI_MIRRORED_IDS)
 *   - item gone from the in-game list  -> its future mirror is deleted, but only
 *                                         when the ESI read was complete
 * Mirrors are found by the "EVE_SRC:<event id>" first line of their description.
 * Throws when ESI auth is unavailable so the run shows as FAILED (Apps Script
 * failure notifications then email you) instead of failing silently every hour.
 */
function syncEveMiningEvents() {
  var cfg = CONFIG.EVE_MINING;
  log_('syncEveMiningEvents start');

  var writeCal = resolveCalendar_(getProp_(PROP_KEYS.WRITE_TO_CALENDAR_ID),
                                  getProp_(PROP_KEYS.WRITE_TO_CALENDAR_NAME),
                                  true, 'WRITE_TO');
  if (!writeCal) {
    log_('ERROR: Could not resolve the WRITE-TO calendar. syncEveMiningEvents end (aborted).');
    return;
  }

  var token = esiGetAccessToken_();
  if (!token) {
    log_('syncEveMiningEvents end (aborted: no ESI access token).');
    throw new Error('syncEveMiningEvents: no ESI access token. Re-run esiLogAuthUrl / '
                    + 'esiStoreAuthCode if the refresh token was revoked.');
  }

  var now = new Date();
  var windowEnd = addDays_(now, cfg.SCAN_DAYS);
  log_('  write-to "' + writeCal.getName() + '", window ' + now + '  ->  ' + windowEnd);

  var fetched = fetchEveMiningItems_(token, windowEnd);
  if (fetched === null) {
    log_('syncEveMiningEvents end (aborted: ESI read failed).');
    throw new Error('syncEveMiningEvents: ESI calendar read failed (see log above).');
  }
  var items = fetched.items;

  var mirrors = indexEveMirrors_(writeCal, addDays_(now, -1), addDays_(windowEnd, 1));
  var mirroredIds = loadMirroredIds_();
  var tolMs = CONFIG.TIME_MATCH_TOLERANCE_MIN * 60 * 1000;

  var created = 0, updated = 0, unchanged = 0, skippedDeleted = 0, failed = 0, removed = 0;
  var currentIds = {};

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    currentIds[item.id] = true;
    var mirror = mirrors[item.id];

    if (mirror) {
      var startOff = Math.abs(mirror.getStartTime().getTime() - item.start.getTime());
      var endOff = Math.abs(mirror.getEndTime().getTime() - item.end.getTime());
      if (startOff <= tolMs && endOff <= tolMs) {
        log_('  SKIP (already mirrored, times match): "' + item.title + '"  '
             + fmtRange_(item.start, item.end));
        unchanged++;
      } else {
        log_('  UPDATING mirror (in-game time changed): "' + item.title + '"  was '
             + fmtRange_(mirror.getStartTime(), mirror.getEndTime())
             + '  now ' + fmtRange_(item.start, item.end));
        try {
          mirror.setTime(item.start, item.end);
          updated++;
        } catch (err) {
          log_('  ERROR updating mirror for "' + item.title + '": ' + err);
          failed++;
        }
      }
      mirroredIds[item.id] = true;
      continue;
    }

    if (mirroredIds[item.id]) {
      log_('  SKIP (mirrored before, no mirror found — assumed deleted by hand, not recreating): "'
           + item.title + '"  id=' + item.id);
      skippedDeleted++;
      continue;
    }

    if (createEveMirror_(writeCal, item, cfg.MARKER_PREFIX + item.id)) {
      mirroredIds[item.id] = true;
      created++;
    } else {
      failed++;
    }
  }

  // Item no longer in the in-game list -> drop its future mirror. Only trusted
  // when the read was complete; in-progress/past mirrors are never touched.
  if (fetched.complete) {
    for (var id in mirrors) {
      if (currentIds[id]) { continue; }
      var stale = mirrors[id];
      if (stale.getStartTime().getTime() <= now.getTime()) {
        log_('  KEEP (no longer listed but already started/past): "' + stale.getTitle() + '"');
        continue;
      }
      try {
        log_('  DELETING mirror (item gone from in-game list): "' + stale.getTitle() + '"  '
             + fmtRange_(stale.getStartTime(), stale.getEndTime()));
        stale.deleteEvent();
        removed++;
      } catch (err) {
        log_('  ERROR deleting stale mirror "' + stale.getTitle() + '": ' + err);
        failed++;
      }
    }
  } else {
    log_('  Skipping gone-item cleanup: ESI read was incomplete (MAX_PAGES).');
  }

  saveMirroredIds_(mirroredIds, currentIds, fetched.complete);

  log_('syncEveMiningEvents end: ' + items.length + ' Mining item(s): created ' + created
       + ', re-timed ' + updated + ', unchanged ' + unchanged + ', hand-deleted (not recreated) '
       + skippedDeleted + ', removed ' + removed + ', FAILED ' + failed + '.');
}


/**
 * Maps eve event id -> mirror CalendarEvent for every event in the window whose
 * description's first line is "EVE_SRC:<id>".
 *
 * @param {Calendar} writeCal
 * @param {Date}     from
 * @param {Date}     to
 * @return {Object} {id: CalendarEvent}. Duplicates of one id keep the first.
 */
function indexEveMirrors_(writeCal, from, to) {
  var prefix = CONFIG.EVE_MINING.MARKER_PREFIX;
  log_('indexEveMirrors_ start: ' + from + '  ->  ' + to);
  var events = writeCal.getEvents(from, to);
  var byId = {};
  var found = 0;
  for (var i = 0; i < events.length; i++) {
    var first = events[i].getDescription().split('\n')[0];
    if (first.indexOf(prefix) !== 0) { continue; }
    var id = first.substring(prefix.length).trim();
    found++;
    if (byId[id]) {
      log_('  WARNING: duplicate mirror for id ' + id + ' ("' + events[i].getTitle() + '"); keeping the first.');
      continue;
    }
    byId[id] = events[i];
  }
  log_('indexEveMirrors_ end: scanned ' + events.length + ' event(s), ' + found
       + ' mirror(s), ' + Object.keys(byId).length + ' distinct id(s).');
  return byId;
}


/**
 * Loads the set of Eve event ids ever mirrored (JSON array in ESI_MIRRORED_IDS).
 * Missing/unparsable -> empty set, which at worst re-creates a hand-deleted
 * mirror once; it never blocks a new one.
 *
 * @return {Object} {id: true}
 */
function loadMirroredIds_() {
  var raw = getProp_(ESI_PROP_KEYS.MIRRORED_IDS);
  var set = {};
  if (raw === '') {
    log_('loadMirroredIds_: none stored.');
    return set;
  }
  try {
    var arr = JSON.parse(raw);
    for (var i = 0; i < arr.length; i++) { set[String(arr[i])] = true; }
    log_('loadMirroredIds_: ' + arr.length + ' id(s).');
  } catch (err) {
    log_('WARNING: ESI_MIRRORED_IDS unparsable (' + err + '); treating as empty.');
  }
  return set;
}


/**
 * Stores the mirrored-id set. When the ESI read was complete, ids no longer in
 * the in-game list are pruned so the property stays small; when incomplete,
 * nothing is pruned.
 *
 * @param {Object}  ids       {id: true} to store.
 * @param {Object}  currentIds ids present in this run's item list.
 * @param {boolean} complete  Whether the ESI read covered the whole list.
 */
function saveMirroredIds_(ids, currentIds, complete) {
  var keep = [];
  for (var id in ids) {
    if (!complete || currentIds[id]) { keep.push(id); }
  }
  PropertiesService.getScriptProperties().setProperty(ESI_PROP_KEYS.MIRRORED_IDS, JSON.stringify(keep));
  log_('saveMirroredIds_: stored ' + keep.length + ' id(s) (pruned ' + (Object.keys(ids).length - keep.length) + ').');
}


/**
 * Creates the mirror event (in-game start, DURATION_MIN long) with color and reminder
 * from CONFIG.EVE_MINING. The description's FIRST line is the EVE_SRC marker.
 *
 * @param {Calendar} writeCal
 * @param {Object}   item
 * @param {string}   marker
 * @return {boolean} true if created.
 */
function createEveMirror_(writeCal, item, marker) {
  var cfg = CONFIG.EVE_MINING;
  var title = cfg.EVENT_TITLE_PREFIX + item.title;
  log_('createEveMirror_ start: "' + title + '"  ' + fmtRange_(item.start, item.end)
       + '  marker=' + marker);
  try {
    var description = marker + '\nMirrored from Eve in-game calendar: ' + item.title;
    if (item.text) { description += '\n\n' + item.text; }

    var ev = writeCal.createEvent(title, item.start, item.end, { description: description });

    if (cfg.COLOR && CalendarApp.EventColor[cfg.COLOR]) {
      ev.setColor(CalendarApp.EventColor[cfg.COLOR]);
    } else if (cfg.COLOR) {
      log_('  WARNING: EVE_MINING.COLOR "' + cfg.COLOR + '" is not a valid EventColor; leaving default.');
    }
    if (cfg.POPUP_REMINDER_MIN !== null && cfg.POPUP_REMINDER_MIN !== undefined) {
      ev.addPopupReminder(cfg.POPUP_REMINDER_MIN);
    }
    log_('createEveMirror_ end: CREATED (color=' + (cfg.COLOR ? cfg.COLOR : 'calendar default') + ', reminder='
         + cfg.POPUP_REMINDER_MIN + ')');
    return true;
  } catch (err) {
    log_('createEveMirror_ end: ERROR creating "' + title + '": ' + err);
    return false;
  }
}


/**
 * ONE-OFF RESET. Deletes every FUTURE Eve mirror in the scan window and clears
 * ESI_MIRRORED_IDS, so the next syncEveMiningEvents recreates them fresh. Use it
 * after changing CONFIG.EVE_MINING.COLOR: the API cannot reset an existing
 * event back to the calendar's default color, so re-created events are the way
 * to apply it. (A changed DURATION_MIN needs no reset — sync re-times mirrors.)
 * Only events whose description starts with the EVE_SRC marker are touched.
 */
function resetEveMirrors() {
  log_('resetEveMirrors start (scan window now + ' + (CONFIG.EVE_MINING.SCAN_DAYS + 1) + ' day(s))');
  var writeCal = resolveCalendar_(getProp_(PROP_KEYS.WRITE_TO_CALENDAR_ID),
                                  getProp_(PROP_KEYS.WRITE_TO_CALENDAR_NAME),
                                  true, 'WRITE_TO');
  if (!writeCal) {
    log_('ERROR: Could not resolve the WRITE-TO calendar. resetEveMirrors end (aborted).');
    return;
  }
  var now = new Date();
  var mirrors = indexEveMirrors_(writeCal, now, addDays_(now, CONFIG.EVE_MINING.SCAN_DAYS + 1));
  log_('  found ' + Object.keys(mirrors).length + ' mirror(s) in the window.');
  var deleted = 0, failed = 0;
  for (var id in mirrors) {
    var ev = mirrors[id];
    if (ev.getStartTime().getTime() <= now.getTime()) {
      log_('  KEEP (already started): "' + ev.getTitle() + '"  ' + fmtRange_(ev.getStartTime(), ev.getEndTime()));
      continue;
    }
    try {
      log_('  DELETING mirror: "' + ev.getTitle() + '"  ' + fmtRange_(ev.getStartTime(), ev.getEndTime()));
      ev.deleteEvent();
      deleted++;
    } catch (err) {
      log_('  ERROR deleting mirror "' + ev.getTitle() + '": ' + err);
      failed++;
    }
  }
  PropertiesService.getScriptProperties().deleteProperty(ESI_PROP_KEYS.MIRRORED_IDS);
  log_('resetEveMirrors end: deleted ' + deleted + ', failed ' + failed
       + ', cleared ESI_MIRRORED_IDS. Run syncEveMiningEvents next.');
}


/**
 * OPTIONAL AUTOMATION. Installs an hourly time trigger for syncEveMiningEvents
 * (ESI has no push notifications). Re-running replaces the old trigger, never
 * stacks.
 */
function installEveMiningTrigger() {
  log_('installEveMiningTrigger start');
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncEveMiningEvents') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  log_('  Removed ' + removed + ' existing syncEveMiningEvents trigger(s).');

  ScriptApp.newTrigger('syncEveMiningEvents')
    .timeBased()
    .everyHours(CONFIG.EVE_MINING.POLL_EVERY_HOURS)
    .create();
  log_('installEveMiningTrigger end: polling every ' + CONFIG.EVE_MINING.POLL_EVERY_HOURS + 'h.');
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
 * Returns a NEW Date offset from the given date by whole calendar DAYS, at
 * local midnight. Unlike addMinutes_, this is DST-safe: it never counts a
 * fixed number of minutes across a spring-forward/fall-back boundary, so
 * "6 days from Sunday midnight" always lands on Saturday midnight, even on
 * the week the clocks change (a fixed-minutes offset would land at 23:00 the
 * day before or 01:00 the day after).
 *
 * @param {Date}   date  Any Date; only the calendar date is used.
 * @param {number} days  May be negative.
 * @return {Date} Midnight local time, `days` calendar days later.
 */
function addDays_(date, days) {
  var d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Resolves the week offset a zero-argument entry point should use.
 *
 * Google Apps Script cannot pass an argument when a function is (a) picked
 * from the editor's Run menu or (b) fired by a time-based trigger — in the
 * trigger case GAS actually passes an EVENT OBJECT as the first argument, not
 * a number. So the argument is trusted only when it is a genuine finite
 * number; anything else (including a trigger event object) falls back to
 * CONFIG.WEEK_OFFSET.
 *
 * @param {*} weekOffset Whatever was passed in, if anything.
 * @return {number}
 */
function resolveWeekOffset_(weekOffset) {
  return (typeof weekOffset === 'number' && isFinite(weekOffset))
       ? weekOffset
       : CONFIG.WEEK_OFFSET;
}

/**
 * The largest absolute block offset across CONFIG.BLOCKS, in minutes. Used to
 * size the reconcile scan-window padding: a block anchored this far from a
 * shift's START/END can land outside the Sun-Fri processing window, so the
 * write-to calendar has to be scanned wider than the shifts are read.
 *
 * @return {number} Always >= 0.
 */
function maxBlockOffsetMin_() {
  var max = 0;
  for (var i = 0; i < CONFIG.BLOCKS.length; i++) {
    var b = CONFIG.BLOCKS[i];
    max = Math.max(max, Math.abs(b.startOffsetMin), Math.abs(b.endOffsetMin));
  }
  return max;
}

/**
 * Computes the target week's processing window plus a padded scan window for
 * reconcile. The processing window (start/end) is exactly the shifts to read
 * (Sunday .. Sunday+NUM_DAYS, calendar days). The scan window (scanStart/
 * scanEnd) is padded by enough whole days to cover the biggest block offset,
 * so helper events that land just outside the shift week (e.g. a "Prep lunch"
 * block 75 minutes before an early-Sunday shift, which falls on Saturday)
 * are still found by findAssistEvents_ and correctly reconciled instead of
 * being reported as perpetually missing.
 *
 * @param {number} offsetWeeks Same meaning as CONFIG.WEEK_OFFSET.
 * @return {{start:Date, end:Date, scanStart:Date, scanEnd:Date}}
 */
function getWeekWindow_(offsetWeeks) {
  var start = getTargetSunday_(offsetWeeks);
  var end = addDays_(start, CONFIG.NUM_DAYS);
  var padDays = Math.ceil(maxBlockOffsetMin_() / (24 * 60));
  return {
    start: start,
    end: end,
    scanStart: addDays_(start, -padDays),
    scanEnd: addDays_(end, padDays)
  };
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

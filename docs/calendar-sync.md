# Calendar sync: Google and iCloud

LifeOS reads your Google and iCloud calendars, so their events show on its calendar. It also writes its own dated items to one Google calendar, which your phone shows with the rest.

## What it does (version 1)

- **Reading.** Events from connected calendars appear on `/calendar`: all-day ones on each day they cover, timed ones at their time. Recurring events repeat as they do in the calendar app, across daylight-saving changes, with moved and cancelled instances applied. LifeOS shows them and never edits them: change an event in Google Calendar or Apple Calendar, and LifeOS has it within a sync.
- **Writing.** One Google calendar, the _push target_, gets LifeOS's own items:
  - a task on its do day, and on its deadline as "Due: …" (one event if those are the same day), until it's done or dropped;
  - a medical visit at its time, for an hour, with the calendar's default reminders;
  - a bill on its next due date;
  - an important date, every year or month when it recurs.
    All-day items don't mark you busy and carry no reminders. Items go out from 7 days ago to a year ahead.
    LifeOS keeps this calendar matching. A changed item updates its event, a finished or deleted one removes it, and an event deleted by hand comes back. Editing a LifeOS event in Google doesn't change the item, and the next change in LifeOS writes over it.
- **Who sees what.** A calendar's events show to its owner. Mark a calendar "The household" and everyone in the household sees it. The push target gets the household's items plus its owner's own private ones, and never another member's private items.
- **How often.** Every `LIFEOS_CALENDAR_SYNC_MINUTES` (default 5), or **Sync now** on the Calendars page. LifeOS is reachable on the tailnet only, so there is no push from Google or Apple: it polls, and each poll fetches only what changed, using sync tokens.

## Setting up the server (once)

All three settings go in the server's `.env` (`/srv/lifeos/.env` on freddy). Restart the app after changing them.

1. **`LIFEOS_SECRET_KEY`**: seals the CalDAV passwords people enter. Make one with `openssl rand -base64 32`. Keep it: without it, stored passwords can't be opened, and everyone has to reconnect. iCloud can't be connected until it's set.
2. **Google**: a service account, which never expires. An OAuth app in "Testing" loses its access after 7 days, and leaving Testing means Google's verification.
   1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, and enable the **Google Calendar API** for it.
   2. Under _IAM & Admin → Service accounts_, create one (no roles needed). Under its _Keys_, add a JSON key and download it.
   3. Put the file on the server, readable only by the app, for example `/srv/lifeos/secrets/google-calendar.json` with mode 600. Mount it into the app container read-only, and point `LIFEOS_GOOGLE_SA_FILE` at its path inside the container, for example `/run/secrets/google-calendar.json`. The mount is a change to freddy's compose file.
   4. The Calendars page then shows the service account's address. That's what people share their calendars with.
3. **`LIFEOS_CALENDAR_SYNC_MINUTES`**: 5 by default; 0 turns the timer off. **Sync now** still works.

## Connecting (each person, at Account → Calendars)

- **iCloud.** At [account.apple.com](https://account.apple.com), open _Sign-In and Security → App-Specific Passwords_ and make one called "LifeOS". Enter your Apple ID and that password; your Apple ID's own password won't work. LifeOS lists your calendars and starts reading them. To connect another CalDAV server (Nextcloud, Fastmail), open _Another CalDAV server_ and enter its address.
- **Google.** In Google Calendar's settings, open a calendar, and under _Share with specific people_ add the service account's address:
  - **See all event details** for a calendar to show in LifeOS;
  - **Make changes to events** for the push target. A new calendar called "LifeOS" keeps its items apart from yours.

  Copy the calendar's ID from _Integrate calendar_ (for your main calendar it's your Gmail address), paste it on the Calendars page, and tick _LifeOS adds its own items to this calendar_ for the push target.

## Testing without credentials

- **Unit tests** (`tests/unit/calendar-sync.test.ts`) cover:
  - time zones and DST;
  - the sealed passwords;
  - iCalendar parsing (EXDATEs in either form, moved instances, unknown zone names through VTIMEZONE);
  - recurrence (across DST, a daily series from 2010 that must still reach this month, window edges);
  - Google's mapping and its signed sign-in.
- **`tests/integration/calendar-google.test.ts`** runs the whole sync against a fake Google API. The fake checks the JWT's signature, pages its results, expires sync tokens (410), and records every write. That covers what's visible to whom, pushing only what changed, putting back an event deleted by hand, and full resync.
- **`tests/integration/calendar-caldav.test.ts`** runs against a real CalDAV server when `CALDAV_TEST_URL` is set (its header shows how to start Radicale in Docker). It covers discovery, the first full sync, incremental changes and deletions, a refused token, and the whole job with a sealed password. Without `CALDAV_TEST_URL` it is skipped, as it is in CI.
- **`tests/e2e/calendar-sync.spec.ts`** covers the pages.

## Not in version 1

- Editing external events from LifeOS, or LifeOS items from Google.
- Writing to iCloud: the push target is a Google calendar, and an iPhone shows it alongside iCloud.
- Pushing every date of a repeating task, or a "custom" important-date rule: only the next date goes out.
- Searching external events, or a page for one.

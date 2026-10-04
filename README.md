# Midnight Reminder

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that gently
reminds you to stop working during a local time window (00:00–06:00 by
default). If Pi is busy when the window opens, the reminder waits and is
delivered automatically as soon as the agent becomes idle, so it never
interrupts a turn in flight.

## Requirements

- **Pi** installed and on your `PATH` (`pi --version`).
- **Node.js 22.18+** (or 23.6+), where TypeScript type stripping is enabled by
  default and `node --test` can run `.ts` files directly.

  On Node 22.6–22.17, add `--experimental-strip-types` to the test commands
  below.

No `package.json` or install step is needed — the extension has no runtime
dependencies, and Node runs the TypeScript sources as-is.

## Files

| File | Purpose |
| --- | --- |
| `midnight-reminder.ts` | The extension: runtime wiring, timers, messages, command. |
| `midnight-schedule.ts` | Pure scheduling helpers (no Pi imports). |
| `bedtime-demo.ts` | Deterministic simulated-time demonstration used by `/bedtime-test`. |
| `midnight-schedule.test.ts` | Unit tests for the scheduling math. |
| `midnight-reminder.test.ts` | Integration tests against a fake Pi runtime, including simulated-time coverage. |
| `bedtime-test.test.ts` | Tests for the `/bedtime-test` command and its simulator. |

## Running the extension

Load it for a single run:

```sh
pi --extension ./midnight-reminder.ts
```

The flag may be repeated to load several extensions, and `--extension` can be
abbreviated as `-e`:

```sh
pi -e ./midnight-reminder.ts
```

Because `--extension` works alongside normal Pi usage, you can combine it with
a prompt, another extension, or a specific session:

```sh
pi -e ./midnight-reminder.ts "help me wrap up for the night"
```

To load it for every Pi session, install the file:

```sh
pi install ./midnight-reminder.ts
```

## Commands

Once loaded, the extension registers a single `/midnight` command:

| Command | Action |
| --- | --- |
| `/midnight now` | Show the reminder immediately (manual override). |
| `/midnight status` | Print the current state and the next scheduled time. |
| `/midnight off` | Disable the schedule for this session. |
| `/midnight on` | Re-arm the schedule. |
| `/bedtime-test` | Run the reminder through simulated time and report pass/fail. |

Running `/midnight` with no argument is the same as `/midnight now`.

### Demonstrating with `/bedtime-test`

`/bedtime-test` runs a frozen-clock simulation of the reminder, so it never
waits for real midnight. It walks the timeline 23:59 -> 00:00 -> 00:30 ->
05:59 -> 06:00 -> next-day 00:00 and reports:

- no reminder before the window opens,
- a reminder at the inclusive 00:00 start,
- **no duplicate reminder for the same local date**, even after several checks,
- a fresh reminder on the next local date,
- an overall `PASS`/`FAIL` summary.

The report also shows the active window and when it triggers, plus a preview
of the exact reminder text that would be delivered, so you can confirm at a
glance what you (or your users) will see:

```text
Midnight Reminder — simulated-time bedtime test: PASS ✅

Window: 00:00-06:00 local — only reminds you during these hours
  (the start time counts; the end time doesn't; and only once per local date).

This is what the reminder looks like when it triggers:
  🌙 It's past midnight. ... Time to call it a night.

...
```

## Configuration

All configuration is via environment variables, read when the extension is
loaded.

| Variable | Default | Description |
| --- | --- | --- |
| `MIDNIGHT_REMINDER_FROM` | `"00:00"` | Window start, `HH:MM` local time. |
| `MIDNIGHT_REMINDER_TO` | `"06:00"` | Window end, `HH:MM` local time (exclusive). |
| `MIDNIGHT_REMINDER_TIME` | — | Legacy alias for `MIDNIGHT_REMINDER_FROM`. |
| `MIDNIGHT_REMINDER_GRACE_MINUTES` | `120` | Derive the window end from the start (used when `TO` is unset). |
| `MIDNIGHT_REMINDER_MESSAGE` | built-in | Custom reminder text. |
| `MIDNIGHT_REMINDER_DISABLED` | — | Set to `1` to start with the schedule disabled. |

Example: a 22:00–06:00 window with a custom message.

```sh
MIDNIGHT_REMINDER_FROM=22:00 \
MIDNIGHT_REMINDER_TO=06:00 \
MIDNIGHT_REMINDER_MESSAGE="Time to rest." \
  pi -e ./midnight-reminder.ts
```

## Behavior

1. On session start, the extension arms a single timer for the next opening of
   the configured window.
2. When the timer fires and Pi is idle, the reminder is delivered as a
   display-only custom message (no `triggerTurn`, so the model does not start
   working again) plus a UI notification when a UI is available.
3. If Pi is busy when the timer fires, the reminder is held and delivered on
   the next `agent_settled` event, once the agent is idle.
4. Delivery is recorded per local calendar day, so reloads, resumes, and
   branch switches do not repeat the same night's reminder.
5. Opening Pi inside the window (e.g. at 03:00) delivers a single catch-up
   reminder. After the window closes, nothing is delivered until the next
   opening.

The reminder timer is `unref`'d, so it never keeps the Pi process alive.

## Running the tests

Run everything:

```sh
node --test
```

Run one suite at a time:

```sh
node --test midnight-schedule.test.ts   # pure scheduling math
node --test midnight-reminder.test.ts   # extension wiring with a fake runtime
node --test bedtime-test.test.ts        # /bedtime-test simulator + command
```

Expected output ends with a summary like:

```text
# tests 32
# pass 32
# fail 0
```

The integration suite uses Node's mock timers (`t.mock.timers`) to freeze
`Date`/`setTimeout`, so it can assert boundary behavior without waiting for
wall-clock time: `23:59` is quiet while `00:00`, `05:59`, and a mid-window
session start deliver, `06:00` is quiet, reminders are deduped per local day,
and `session_shutdown` cancels the pending timer.

## Trying it without waiting for midnight

Use a window that starts a couple of minutes ago and ends in the near future,
then start Pi inside that window to trigger the catch-up path:

```sh
MIDNIGHT_REMINDER_FROM="$(date -d '-2 min' +%H:%M)" \
MIDNIGHT_REMINDER_TO="$(date -d '+30 min' +%H:%M)" \
  pi -e ./midnight-reminder.ts
```

On macOS, `date -v-2M` / `date -v+30M` replace the GNU `date -d` forms above.
Alternatively, just run `/midnight now` after loading the extension.

/**
 * Pure scheduling helpers for the Midnight Reminder extension.
 *
 * Kept free of any Pi imports so the logic can be unit-tested with
 * `node --test` and reasoned about in isolation.
 */

export interface ReminderTime {
	/** Hour of day, 0-23 */
	hours: number;
	/** Minute of hour, 0-59 */
	minutes: number;
}

const TIME_OF_DAY = /^(\d{1,2}):(\d{2})$/;

/**
 * Parse a `HH:MM` (24-hour) string into a {@link ReminderTime}.
 * Returns `null` for anything that is not a valid time of day.
 */
export function parseTimeOfDay(input: string): ReminderTime | null {
	const match = TIME_OF_DAY.exec(input.trim());
	if (!match) return null;

	const hours = Number(match[1]);
	const minutes = Number(match[2]);

	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

	return { hours, minutes };
}

/** The local calendar date of `date` as `YYYY-MM-DD` (used to dedupe daily reminders). */
export function dateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** Build the Date for `time` on the same local calendar day as `base`. */
export function timeOfDayOn(time: ReminderTime, base: Date): Date {
	const result = new Date(base);
	result.setHours(time.hours, time.minutes, 0, 0);
	return result;
}

/**
 * Milliseconds from `now` until the next occurrence of `time`.
 * If `time` has just passed (or is exactly now), the next occurrence is
 * tomorrow, so the result is always in `(0, 24h]`.
 */
export function msUntilNext(time: ReminderTime, now: Date): number {
	const upcoming = timeOfDayOn(time, now);
	if (upcoming.getTime() <= now.getTime()) {
		upcoming.setDate(upcoming.getDate() + 1);
	}
	return upcoming.getTime() - now.getTime();
}

/**
 * Milliseconds elapsed since today's occurrence of `time`.
 * Negative when the occurrence is still in the future.
 */
export function msSinceTimeOfDay(time: ReminderTime, now: Date): number {
	return now.getTime() - timeOfDayOn(time, now).getTime();
}

/** Format a {@link ReminderTime} back to a padded `HH:MM` string. */
export function formatTimeOfDay(time: ReminderTime): string {
	const hours = String(time.hours).padStart(2, "0");
	const minutes = String(time.minutes).padStart(2, "0");
	return `${hours}:${minutes}`;
}

/** A local time-of-day range during which the reminder is considered due. */
export interface ReminderWindow {
	/** Start of the window (inclusive). The reminder fires here. */
	from: ReminderTime;
	/** End of the window (exclusive). After this, catch-up stops. */
	to: ReminderTime;
}

/** Minutes since local midnight for a {@link ReminderTime}. */
function toMinutes(time: ReminderTime): number {
	return time.hours * 60 + time.minutes;
}

/** Local minutes since midnight for `date`. */
export function minuteOfDay(date: Date): number {
	return date.getHours() * 60 + date.getMinutes();
}

/**
 * Shift `time` by `minutes` (which may be negative), wrapping around the
 * 24-hour clock. Useful for turning a start time plus a duration into an end
 * time. The result is not rounded to a whole minute boundary, matching the
 * precision of {@link ReminderTime}.
 */
export function addMinutes(time: ReminderTime, minutes: number): ReminderTime {
	const day = 24 * 60;
	const total = (((toMinutes(time) + minutes) % day) + day) % day;
	return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/**
 * Parse a window from two `HH:MM` strings. Returns `null` when either end is
 * invalid (e.g. "24:00" or "noon").
 */
export function parseWindow(
	fromInput: string,
	toInput: string,
): ReminderWindow | null {
	const from = parseTimeOfDay(fromInput);
	const to = parseTimeOfDay(toInput);
	if (!from || !to) return null;
	return { from, to };
}

/**
 * Whether `now` falls inside the window. The start is inclusive, the end is
 * exclusive. Windows may wrap past midnight (for example `22:00` -> `06:00`).
 * A window whose ends are equal is treated as empty.
 */
export function isWithinWindow(window: ReminderWindow, now: Date): boolean {
	const current = minuteOfDay(now);
	const from = toMinutes(window.from);
	const to = toMinutes(window.to);

	if (from === to) return false;
	if (from < to) return current >= from && current < to;
	// Wraps past midnight: from -> 24:00 plus 00:00 -> to.
	return current >= from || current < to;
}

/** Format a {@link ReminderWindow} as `HH:MM-HH:MM`. */
export function formatWindow(window: ReminderWindow): string {
	return `${formatTimeOfDay(window.from)}-${formatTimeOfDay(window.to)}`;
}

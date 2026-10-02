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

/**
 * Whether today's reminder was missed while Pi was closed but is still
 * worth delivering: the target time has passed and we are within `graceMs`.
 */
export function shouldCatchUp(
	time: ReminderTime,
	now: Date,
	graceMs: number,
): boolean {
	const elapsed = msSinceTimeOfDay(time, now);
	return elapsed >= 0 && elapsed <= graceMs;
}

/** Format a {@link ReminderTime} back to a padded `HH:MM` string. */
export function formatTimeOfDay(time: ReminderTime): string {
	const hours = String(time.hours).padStart(2, "0");
	const minutes = String(time.minutes).padStart(2, "0");
	return `${hours}:${minutes}`;
}

/**
 * Deterministic, simulated-time demonstration of the Midnight Reminder.
 *
 * The `/bedtime-test` command runs this module. It drives a tiny state machine
 * that mirrors the extension's per-day dedupe, but takes "now" as an argument,
 * so the whole scenario runs instantly on a frozen clock instead of waiting
 * for real midnight.
 *
 * Kept free of Pi imports so `node --test` can exercise it directly.
 */

import {
	type ReminderWindow,
	dateKey,
	isWithinWindow,
} from "./midnight-schedule.ts";

/** One evaluated instant in the simulated timeline. */
export interface BedtimeStep {
	/** The simulated wall-clock time. */
	at: Date;
	/** Whether a reminder was delivered at this instant. */
	fired: boolean;
	/** Whether a reminder was suppressed because one already fired that day. */
	deduped: boolean;
}

/** A single named assertion produced by the demonstration. */
export interface BedtimeCheck {
	name: string;
	passed: boolean;
	detail: string;
}

/** The full result of a `/bedtime-test` run. */
export interface BedtimeTestResult {
	passed: boolean;
	window: ReminderWindow;
	steps: BedtimeStep[];
	deliveries: number;
	uniqueDays: number;
	checks: BedtimeCheck[];
}

const DEFAULT_WINDOW: ReminderWindow = {
	from: { hours: 0, minutes: 0 },
	to: { hours: 6, minutes: 0 },
};

/**
 * Stateful simulator of the reminder's "at most once per local date" rule.
 *
 * `check` is pure with respect to time: callers pass the simulated instant, so
 * the same sequence always produces the same result.
 */
export class ReminderSimulator {
	private deliveredOn: string | null = null;
	private readonly deliveredDays: string[] = [];
	readonly window: ReminderWindow;

	constructor(window: ReminderWindow) {
		this.window = window;
	}

	/** Number of reminders delivered so far. */
	get deliveries(): number {
		return this.deliveredDays.length;
	}

	/** Distinct local dates on which a reminder was delivered. */
	get uniqueDays(): number {
		return new Set(this.deliveredDays).size;
	}

	/** Evaluate the schedule at a simulated instant. */
	check(now: Date): BedtimeStep {
		const today = dateKey(now);

		if (!isWithinWindow(this.window, now)) {
			return { at: now, fired: false, deduped: false };
		}

		if (this.deliveredOn === today) {
			return { at: now, fired: false, deduped: true };
		}

		this.deliveredOn = today;
		this.deliveredDays.push(today);
		return { at: now, fired: true, deduped: false };
	}
}

/** Format a simulated instant as `YYYY-MM-DD HH:MM`. */
export function formatStepTime(at: Date): string {
	const day = dateKey(at);
	const hh = String(at.getHours()).padStart(2, "0");
	const mm = String(at.getMinutes()).padStart(2, "0");
	return `${day} ${hh}:${mm}`;
}

/**
 * Run the simulated-time demonstration and report whether every expectation
 * held. Uses a fixed clock (2024-05-17 -> 2024-05-19) so results are stable
 * across machines and time zones (dates are treated as local, as in the
 * extension).
 */
export function runBedtimeTest(
	window: ReminderWindow = DEFAULT_WINDOW,
): BedtimeTestResult {
	const sim = new ReminderSimulator(window);
	const steps: BedtimeStep[] = [];

	// Deliberately use a fixed local date and let `new Date` resolve it in the
	// host time zone; `dateKey` reads the same local fields back.
	const at = (day: number, hours: number, minutes: number) =>
		new Date(2024, 4, day, hours, minutes, 0, 0);

	// 1. Quiet just before the window opens.
	steps.push(sim.check(at(17, 23, 59)));
	// 2. Fires at the inclusive start of the window.
	steps.push(sim.check(at(18, 0, 0)));
	// 3. Does not fire again later the same night.
	steps.push(sim.check(at(18, 0, 30)));
	// 4. Still deduped right before the window closes.
	steps.push(sim.check(at(18, 5, 59)));
	// 5. Quiet at the exclusive end of the window.
	steps.push(sim.check(at(18, 6, 0)));
	// 6. Fires again on the next local date.
	steps.push(sim.check(at(19, 0, 0)));
	// 7. Deduped again on that new date.
	steps.push(sim.check(at(19, 3, 0)));

	const checks: BedtimeCheck[] = [
		{
			name: "quiet before the window (23:59)",
			passed: steps[0].fired === false && steps[0].deduped === false,
			detail: `${formatStepTime(steps[0].at)} -> no reminder`,
		},
		{
			name: "fires at the inclusive start (00:00)",
			passed: steps[1].fired === true,
			detail: `${formatStepTime(steps[1].at)} -> reminder delivered`,
		},
		{
			name: "no duplicate later the same night (00:30)",
			passed: steps[2].deduped === true && steps[2].fired === false,
			detail: `${formatStepTime(steps[2].at)} -> deduped`,
		},
		{
			name: "no duplicate near the window end (05:59)",
			passed: steps[3].deduped === true && steps[3].fired === false,
			detail: `${formatStepTime(steps[3].at)} -> deduped`,
		},
		{
			name: "quiet once the window closes (06:00)",
			passed: steps[4].fired === false && steps[4].deduped === false,
			detail: `${formatStepTime(steps[4].at)} -> exclusive end, no reminder`,
		},
		{
			name: "fires again on a new local date",
			passed: steps[5].fired === true,
			detail: `${formatStepTime(steps[5].at)} -> reminder delivered`,
		},
		{
			name: "no duplicate on the new local date",
			passed: steps[6].deduped === true && steps[6].fired === false,
			detail: `${formatStepTime(steps[6].at)} -> deduped`,
		},
		{
			name: "exactly one reminder per local date",
			passed: sim.deliveries === 2 && sim.uniqueDays === 2,
			detail: `${sim.deliveries} deliveries across ${sim.uniqueDays} distinct date(s)`,
		},
	];

	return {
		passed: checks.every((check) => check.passed),
		window,
		steps,
		deliveries: sim.deliveries,
		uniqueDays: sim.uniqueDays,
		checks,
	};
}

/** Render a human-readable report for the `/bedtime-test` command. */
export function formatBedtimeReport(result: BedtimeTestResult): string {
	const lines = [
		`Midnight Reminder — simulated-time bedtime test: ${result.passed ? "PASS ✅" : "FAIL ❌"}`,
		"",
		...result.checks.map(
			(check) => `${check.passed ? "✅" : "❌"} ${check.name} — ${check.detail}`,
		),
		"",
		`${result.deliveries} reminder(s) across ${result.uniqueDays} distinct local date(s).`,
	];
	return lines.join("\n");
}

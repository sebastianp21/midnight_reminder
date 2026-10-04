/**
 * Unit tests for the pure Midnight Reminder scheduling helpers.
 *
 * Run with:
 *   node --test midnight-schedule.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addMinutes,
	dateKey,
	formatTimeOfDay,
	formatWindow,
	isWithinWindow,
	minuteOfDay,
	msSinceTimeOfDay,
	msUntilNext,
	parseTimeOfDay,
	parseWindow,
	timeOfDayOn,
} from "./midnight-schedule.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A local date with a fixed wall-clock time, independent of the test machine. */
function at(hours: number, minutes: number, seconds = 0): Date {
	const d = new Date(2024, 4, 17, hours, minutes, seconds, 0);
	return d;
}

test("parseTimeOfDay accepts valid 24-hour times", () => {
	assert.deepEqual(parseTimeOfDay("00:00"), { hours: 0, minutes: 0 });
	assert.deepEqual(parseTimeOfDay("23:59"), { hours: 23, minutes: 59 });
	assert.deepEqual(parseTimeOfDay("7:05"), { hours: 7, minutes: 5 });
	assert.deepEqual(parseTimeOfDay(" 12:30 "), { hours: 12, minutes: 30 });
});

test("parseTimeOfDay rejects malformed or out-of-range times", () => {
	for (const bad of ["", "24:00", "12:60", "-1:00", "noon", "1230", "1:2"]) {
		assert.equal(parseTimeOfDay(bad), null, `expected ${JSON.stringify(bad)} to be invalid`);
	}
});

test("dateKey uses local calendar dates", () => {
	assert.equal(dateKey(at(0, 0)), "2024-05-17");
	assert.equal(dateKey(at(23, 59)), "2024-05-17");
});

test("timeOfDayOn keeps the base calendar day", () => {
	const when = timeOfDayOn({ hours: 0, minutes: 0 }, at(15, 30));
	assert.equal(when.getFullYear(), 2024);
	assert.equal(when.getMonth(), 4);
	assert.equal(when.getDate(), 17);
	assert.equal(when.getHours(), 0);
	assert.equal(when.getMinutes(), 0);
});

test("msUntilNext counts down to tonight's midnight", () => {
	assert.equal(msUntilNext({ hours: 0, minutes: 0 }, at(23, 0)), HOUR);
	assert.equal(msUntilNext({ hours: 0, minutes: 0 }, at(0, 30)), 23.5 * HOUR);
});

test("msUntilNext is strictly positive and rolls to tomorrow at the target", () => {
	assert.equal(msUntilNext({ hours: 0, minutes: 0 }, at(0, 0)), 24 * HOUR);
	assert.equal(msUntilNext({ hours: 0, minutes: 0 }, at(0, 0, 1)), 24 * HOUR - 1000);
});

test("msSinceTimeOfDay is negative before the target and positive after", () => {
	assert.equal(msSinceTimeOfDay({ hours: 12, minutes: 0 }, at(11, 0)), -HOUR);
	assert.equal(msSinceTimeOfDay({ hours: 0, minutes: 0 }, at(1, 0)), HOUR);
	assert.equal(msSinceTimeOfDay({ hours: 0, minutes: 0 }, at(0, 0)), 0);
});

test("minuteOfDay is the local minute count", () => {
	assert.equal(minuteOfDay(at(0, 0)), 0);
	assert.equal(minuteOfDay(at(1, 30)), 90);
	assert.equal(minuteOfDay(at(23, 59)), 1439);
});

test("addMinutes wraps around the 24-hour clock", () => {
	assert.deepEqual(addMinutes({ hours: 0, minutes: 0 }, 90), { hours: 1, minutes: 30 });
	assert.deepEqual(addMinutes({ hours: 23, minutes: 30 }, 45), { hours: 0, minutes: 15 });
	assert.deepEqual(addMinutes({ hours: 1, minutes: 0 }, -90), { hours: 23, minutes: 30 });
});

test("parseWindow parses two valid times and rejects bad input", () => {
	assert.deepEqual(parseWindow("00:00", "06:00"), {
		from: { hours: 0, minutes: 0 },
		to: { hours: 6, minutes: 0 },
	});
	assert.equal(parseWindow("00:00", "25:00"), null);
	assert.equal(parseWindow("noon", "06:00"), null);
});

test("isWithinWindow includes the start and excludes the end", () => {
	const window = { from: { hours: 0, minutes: 0 }, to: { hours: 6, minutes: 0 } };
	assert.equal(isWithinWindow(window, at(23, 59)), false, "before the window");
	assert.equal(isWithinWindow(window, at(0, 0)), true, "at the inclusive start");
	assert.equal(isWithinWindow(window, at(3, 30)), true, "inside the window");
	assert.equal(isWithinWindow(window, at(5, 59)), true, "one minute before the end");
	assert.equal(isWithinWindow(window, at(6, 0)), false, "at the exclusive end");
	assert.equal(isWithinWindow(window, at(12, 0)), false, "after the window");
});

test("isWithinWindow supports windows that wrap past midnight", () => {
	const window = { from: { hours: 22, minutes: 0 }, to: { hours: 6, minutes: 0 } };
	assert.equal(isWithinWindow(window, at(23, 0)), true);
	assert.equal(isWithinWindow(window, at(2, 0)), true);
	assert.equal(isWithinWindow(window, at(12, 0)), false);
});

test("an empty window (equal ends) never contains a time", () => {
	const window = { from: { hours: 3, minutes: 0 }, to: { hours: 3, minutes: 0 } };
	assert.equal(isWithinWindow(window, at(3, 0)), false);
});

test("formatWindow renders a readable range", () => {
	assert.equal(
		formatWindow({ from: { hours: 0, minutes: 0 }, to: { hours: 6, minutes: 0 } }),
		"00:00-06:00",
	);
});

test("formatTimeOfDay is the inverse of parseTimeOfDay for valid input", () => {
	for (const input of ["00:00", "07:05", "23:59"]) {
		const parsed = parseTimeOfDay(input);
		assert.ok(parsed);
		assert.equal(formatTimeOfDay(parsed), input);
	}
});

/**
 * Unit tests for the pure Midnight Reminder scheduling helpers.
 *
 * Run with:
 *   node --test midnight-schedule.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	dateKey,
	formatTimeOfDay,
	msSinceTimeOfDay,
	msUntilNext,
	parseTimeOfDay,
	shouldCatchUp,
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

test("shouldCatchUp only fires inside the grace window", () => {
	const time = { hours: 0, minutes: 0 };
	// Before midnight: never.
	assert.equal(shouldCatchUp(time, at(23, 59), HOUR), false);
	// 30 minutes late with a 2h window: yes.
	assert.equal(shouldCatchUp(time, at(0, 30), 2 * HOUR), true);
	// Exactly at the edge: yes.
	assert.equal(shouldCatchUp(time, at(2, 0), 2 * HOUR), true);
	// Just past the edge: no.
	assert.equal(shouldCatchUp(time, at(2, 1), 2 * HOUR), false);
});

test("formatTimeOfDay is the inverse of parseTimeOfDay for valid input", () => {
	for (const input of ["00:00", "07:05", "23:59"]) {
		const parsed = parseTimeOfDay(input);
		assert.ok(parsed);
		assert.equal(formatTimeOfDay(parsed), input);
	}
});

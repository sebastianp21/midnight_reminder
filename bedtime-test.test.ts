/**
 * Tests for the `/bedtime-test` simulated-time demonstration.
 *
 * These cover both the pure simulator and the slash command wired into the
 * Midnight Reminder extension.
 *
 * Run with:
 *   node --test bedtime-test.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import midnightReminder from "./midnight-reminder.ts";
import {
	ReminderSimulator,
	formatBedtimeReport,
	runBedtimeTest,
} from "./bedtime-demo.ts";

const WINDOW = {
	from: { hours: 0, minutes: 0 },
	to: { hours: 6, minutes: 0 },
};

const at = (day: number, hours: number, minutes: number) =>
	new Date(2024, 4, day, hours, minutes, 0, 0);

test("runBedtimeTest passes every simulated-time check", () => {
	const result = runBedtimeTest(WINDOW);
	assert.equal(result.passed, true, formatBedtimeReport(result));
	assert.ok(
		result.checks.every((check) => check.passed),
		"all named checks pass",
	);
	assert.equal(result.deliveries, 2);
	assert.equal(result.uniqueDays, 2);
});

test("simulated time: quiet before the window and fires at the inclusive start", () => {
	const sim = new ReminderSimulator(WINDOW);

	const before = sim.check(at(17, 23, 59));
	assert.deepEqual(
		{ fired: before.fired, deduped: before.deduped },
		{ fired: false, deduped: false },
	);

	const open = sim.check(at(18, 0, 0));
	assert.equal(open.fired, true);
	assert.equal(open.deduped, false);
	assert.equal(sim.deliveries, 1);
});

test("simulated time: no duplicate reminder for the same date", () => {
	const sim = new ReminderSimulator(WINDOW);

	assert.equal(sim.check(at(18, 0, 0)).fired, true);
	for (const [hours, minutes] of [
		[0, 30],
		[3, 0],
		[5, 59],
	] as const) {
		const step = sim.check(at(18, hours, minutes));
		assert.equal(step.fired, false, `no reminder at ${hours}:${minutes}`);
		assert.equal(step.deduped, true, `deduped at ${hours}:${minutes}`);
	}
	assert.equal(sim.deliveries, 1, "exactly one delivery for the date");
});

test("simulated time: a new local date re-arms the reminder", () => {
	const sim = new ReminderSimulator(WINDOW);

	assert.equal(sim.check(at(18, 0, 0)).fired, true);
	assert.equal(sim.check(at(18, 4, 0)).deduped, true);
	assert.equal(sim.check(at(19, 0, 0)).fired, true, "next day fires again");
	assert.equal(sim.uniqueDays, 2);
	assert.equal(sim.deliveries, 2);
});

test("simulated time: the window end is exclusive", () => {
	const sim = new ReminderSimulator(WINDOW);
	const closed = sim.check(at(18, 6, 0));
	assert.equal(closed.fired, false);
	assert.equal(closed.deduped, false);
	assert.equal(sim.deliveries, 0);
});

test("formatBedtimeReport summarizes the run", () => {
	const report = formatBedtimeReport(runBedtimeTest(WINDOW));
	assert.match(report, /PASS/);
	assert.match(report, /no duplicate/i);
	assert.match(report, /2 reminder\(s\) across 2 distinct local date\(s\)/);
});

interface Harness {
	commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	messages: Array<Record<string, unknown>>;
	notifications: Array<{ message: string; type: string }>;
	ctx: () => Record<string, unknown>;
}

function makeHarness(): Harness {
	const commands: Harness["commands"] = {};
	const messages: Harness["messages"] = [];
	const notifications: Harness["notifications"] = [];

	const pi = {
		on() {},
		registerCommand(name: string, def: Harness["commands"][string]) {
			commands[name] = def;
		},
		appendEntry() {},
		sendMessage(msg: Record<string, unknown>) {
			messages.push(msg);
		},
	};

	midnightReminder(pi as never);

	const ctx = () => ({
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			notify: (message: string, type?: string) =>
				notifications.push({ message, type: type ?? "info" }),
			setStatus() {},
		},
	});

	return { commands, messages, notifications, ctx };
}

test("the extension exposes /bedtime-test and it reports a pass", async (t) => {
	process.env.MIDNIGHT_REMINDER_MESSAGE = "bed";
	process.env.MIDNIGHT_REMINDER_FROM = "22:00";
	process.env.MIDNIGHT_REMINDER_TO = "06:00";
	t.after(() => {
		delete process.env.MIDNIGHT_REMINDER_MESSAGE;
		delete process.env.MIDNIGHT_REMINDER_FROM;
		delete process.env.MIDNIGHT_REMINDER_TO;
	});

	const h = makeHarness();
	const command = h.commands["bedtime-test"];
	assert.ok(command, "registers the /bedtime-test command");

	await command.handler("", h.ctx());

	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].display, true);
	assert.match(String(h.messages[0].content), /PASS/);
	assert.ok(
		h.notifications.some((n) => n.message.includes("passed")),
		"notifies a passing summary",
	);
});

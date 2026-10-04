/**
 * Integration tests for the Midnight Reminder extension.
 *
 * These exercise the extension wiring with a lightweight fake Pi runtime:
 * no network, no real session, no timers that outlive the test.
 *
 * Run with:
 *   node --test midnight-reminder.test.ts
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import midnightReminder from "./midnight-reminder.ts";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface Harness {
	handlers: Record<string, Handler[]>;
	commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	entries: Array<{ type: string; data: unknown }>;
	messages: Array<Record<string, unknown>>;
	notifications: string[];
	notificationTypes: string[];
	statuses: Array<[string, string]>;
	branch: unknown[];
	emit: (event: string, ctx: unknown) => Promise<void>;
	ctx: (overrides?: Record<string, unknown>) => Record<string, unknown>;
}

function makeHarness(): Harness {
	const handlers: Harness["handlers"] = {};
	const commands: Harness["commands"] = {};
	const entries: Harness["entries"] = [];
	const messages: Harness["messages"] = [];
	const notifications: string[] = [];
	const notificationTypes: string[] = [];
	const statuses: Harness["statuses"] = [];
	const branch: unknown[] = [];

	const pi = {
		on(event: string, handler: Handler) {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand(name: string, def: Harness["commands"][string]) {
			commands[name] = def;
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
		sendMessage(msg: Record<string, unknown>) {
			messages.push(msg);
		},
	};

	const ctx = (overrides: Record<string, unknown> = {}) => ({
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push(message);
				notificationTypes.push(type ?? "info");
			},
			setStatus: (key: string, value: string) => statuses.push([key, value]),
		},
		...overrides,
	});

	const emit = async (event: string, context: unknown) => {
		for (const handler of handlers[event] ?? []) {
			await handler({ type: event }, context);
		}
	};

	// Build the harness before invoking the factory so registrations land here.
	midnightReminder(pi as never);

	return { handlers, commands, entries, messages, notifications, notificationTypes, statuses, branch, emit, ctx };
}

/** A time-of-day window that is guaranteed to contain "now". */
function windowAroundNow(): { from: string; to: string } {
	const now = new Date();
	const nowMin = now.getHours() * 60 + now.getMinutes();
	const fmt = (m: number) => {
		const v = (((m % 1440) + 1440) % 1440);
		return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
	};
	return { from: fmt(nowMin - 2), to: fmt(nowMin + 10) };
}

test("delivers a catch-up reminder when a session starts inside the window", async (t) => {
	const { from, to } = windowAroundNow();
	process.env.MIDNIGHT_REMINDER_FROM = from;
	process.env.MIDNIGHT_REMINDER_TO = to;
	process.env.MIDNIGHT_REMINDER_MESSAGE = "go to bed";
	delete process.env.MIDNIGHT_REMINDER_DISABLED;
	t.after(() => {
		delete process.env.MIDNIGHT_REMINDER_FROM;
		delete process.env.MIDNIGHT_REMINDER_TO;
		delete process.env.MIDNIGHT_REMINDER_MESSAGE;
	});

	const h = makeHarness();
	assert.ok(h.commands.midnight, "registers the /midnight command");

	await h.emit("session_start", h.ctx());

	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].customType, "midnight-reminder");
	assert.equal(h.messages[0].content, "go to bed");
	assert.equal(h.messages[0].display, true);
	assert.equal(h.messages[0].triggerTurn, undefined);
	assert.deepEqual(h.entries.length, 1);
	assert.equal(h.entries[0].type, "midnight-reminder");
});

test("defers delivery until the agent is idle", async (t) => {
	const { from, to } = windowAroundNow();
	process.env.MIDNIGHT_REMINDER_FROM = from;
	process.env.MIDNIGHT_REMINDER_TO = to;
	process.env.MIDNIGHT_REMINDER_MESSAGE = "sleep";
	t.after(() => {
		delete process.env.MIDNIGHT_REMINDER_FROM;
		delete process.env.MIDNIGHT_REMINDER_TO;
		delete process.env.MIDNIGHT_REMINDER_MESSAGE;
	});

	const h = makeHarness();
	await h.emit("session_start", h.ctx({ isIdle: () => false }));

	assert.equal(h.messages.length, 0, "does not interrupt a busy agent");

	await h.emit("agent_settled", h.ctx({ isIdle: () => true }));

	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].content, "sleep");
});

test("does not deliver twice for the same branch/date", async (t) => {
	const { from, to } = windowAroundNow();
	process.env.MIDNIGHT_REMINDER_FROM = from;
	process.env.MIDNIGHT_REMINDER_TO = to;
	process.env.MIDNIGHT_REMINDER_MESSAGE = "bed";
	t.after(() => {
		delete process.env.MIDNIGHT_REMINDER_FROM;
		delete process.env.MIDNIGHT_REMINDER_TO;
		delete process.env.MIDNIGHT_REMINDER_MESSAGE;
	});

	const h = makeHarness();
	await h.emit("session_start", h.ctx());
	assert.equal(h.messages.length, 1);

	// Simulate a reload that can see the persisted delivery entry.
	h.branch.push({ type: "custom", customType: "midnight-reminder", data: h.entries[0].data });
	await h.emit("session_start", h.ctx());

	assert.equal(h.messages.length, 1, "a reload on the same night stays quiet");
});

test("supports /midnight now, status, and off/on", async (t) => {
	delete process.env.MIDNIGHT_REMINDER_FROM;
	delete process.env.MIDNIGHT_REMINDER_TO;
	delete process.env.MIDNIGHT_REMINDER_TIME;
	process.env.MIDNIGHT_REMINDER_MESSAGE = "rest";
	t.after(() => {
		delete process.env.MIDNIGHT_REMINDER_MESSAGE;
	});

	const h = makeHarness();
	const command = h.commands.midnight;
	const ctx = h.ctx();

	await command.handler("now", ctx);
	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].content, "rest");

	await command.handler("status", ctx);
	assert.ok(h.notifications.some((n) => n.includes("armed")));

	await command.handler("off", ctx);
	assert.ok(h.notifications.some((n) => n.includes("disabled")));

	// Disabled reminders stay quiet even for a manual show.
	await command.handler("now", ctx);
	assert.equal(h.messages.length, 2, "manual show still works while disabled");
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Configure the reminder window used by the simulated-time tests. */
function setWindow(from = "00:00", to = "06:00"): void {
	process.env.MIDNIGHT_REMINDER_FROM = from;
	process.env.MIDNIGHT_REMINDER_TO = to;
	delete process.env.MIDNIGHT_REMINDER_TIME;
	delete process.env.MIDNIGHT_REMINDER_GRACE_MINUTES;
}

/** Remove every reminder env var touched by a test. */
function clearEnv(): void {
	for (const key of [
		"MIDNIGHT_REMINDER_FROM",
		"MIDNIGHT_REMINDER_TO",
		"MIDNIGHT_REMINDER_TIME",
		"MIDNIGHT_REMINDER_GRACE_MINUTES",
		"MIDNIGHT_REMINDER_MESSAGE",
		"MIDNIGHT_REMINDER_DISABLED",
	]) {
		delete process.env[key];
	}
}

/**
 * Freeze `Date` and `setTimeout` at `at`, so the test can advance the clock
 * with `t.mock.timers.tick(...)` and observe the extension's real timer logic
 * without waiting for wall-clock time.
 */
function simulateClock(t: TestContext, at: Date): void {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	t.mock.timers.setTime(at.getTime());
}

test("simulated time: 23:59 is quiet and 00:00 fires automatically", async (t) => {
	simulateClock(t, new Date(2024, 4, 17, 23, 59, 0));
	setWindow();
	process.env.MIDNIGHT_REMINDER_MESSAGE = "go to bed";
	t.after(clearEnv);

	const h = makeHarness();
	await h.emit("session_start", h.ctx());

	assert.equal(h.messages.length, 0, "23:59 is before the 00:00 window");
	assert.equal(h.entries.length, 0);

	// Advance one minute; the armed timer must deliver while Pi is running.
	t.mock.timers.tick(MINUTE);

	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].customType, "midnight-reminder");
	assert.equal(h.messages[0].content, "go to bed");
	assert.equal(h.messages[0].display, true);
	assert.equal(h.messages[0].triggerTurn, undefined);
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].type, "midnight-reminder");
	// Notification behavior: one info toast, plus a status badge update.
	assert.deepEqual(h.notifications, ["go to bed"]);
	assert.deepEqual(h.notificationTypes, ["info"]);
	assert.ok(h.statuses.some(([, value]) => value.includes("🌙")));
});

test("simulated time: opening exactly at 00:00 delivers the reminder", async (t) => {
	simulateClock(t, new Date(2024, 4, 17, 0, 0, 0));
	setWindow();
	process.env.MIDNIGHT_REMINDER_MESSAGE = "midnight";
	t.after(clearEnv);

	const h = makeHarness();
	await h.emit("session_start", h.ctx());

	assert.equal(h.messages.length, 1, "00:00 is the inclusive window start");
	assert.equal(h.messages[0].content, "midnight");
});

test("simulated time: 05:59 is still inside the window", async (t) => {
	simulateClock(t, new Date(2024, 4, 17, 5, 59, 0));
	setWindow();
	process.env.MIDNIGHT_REMINDER_MESSAGE = "almost six";
	t.after(clearEnv);

	const h = makeHarness();
	await h.emit("session_start", h.ctx());

	assert.equal(h.messages.length, 1, "delivers one minute before the end");
});

test("simulated time: 06:00 is outside the window", async (t) => {
	simulateClock(t, new Date(2024, 4, 17, 6, 0, 0));
	setWindow();
	process.env.MIDNIGHT_REMINDER_MESSAGE = "too late";
	t.after(clearEnv);

	const h = makeHarness();
	await h.emit("session_start", h.ctx());

	assert.equal(h.messages.length, 0, "06:00 is the exclusive window end");
	// The next opening is ~18h away; advancing within the same day stays quiet.
	t.mock.timers.tick(17 * 60 * MINUTE);
	assert.equal(h.messages.length, 0);
});

test("simulated time: repeated checks deliver at most once per day", async (t) => {
	simulateClock(t, new Date(2024, 4, 17, 0, 0, 0));
	setWindow();
	process.env.MIDNIGHT_REMINDER_MESSAGE = "bed";
	t.after(clearEnv);

	const h = makeHarness();
	await h.emit("session_start", h.ctx());
	assert.equal(h.messages.length, 1);

	// A reload later the same night must stay quiet.
	t.mock.timers.tick(30 * MINUTE);
	h.branch.push({
		type: "custom",
		customType: "midnight-reminder",
		data: h.entries[0].data,
	});
	await h.emit("session_start", h.ctx());
	assert.equal(h.messages.length, 1, "same-day reload is deduped");

	// The next midnight is a new local day, so it delivers again.
	t.mock.timers.tick(DAY);
	assert.equal(h.messages.length, 2, "a new day re-arms the reminder");
	const first = (h.entries[0].data as { deliveredOn: string }).deliveredOn;
	const second = (h.entries[1].data as { deliveredOn: string }).deliveredOn;
	assert.notEqual(first, second);
});

test("simulated time: session shutdown cancels the pending timer", async (t) => {
	simulateClock(t, new Date(2024, 4, 17, 23, 59, 0));
	setWindow();
	process.env.MIDNIGHT_REMINDER_MESSAGE = "should not fire";
	t.after(clearEnv);

	const h = makeHarness();
	await h.emit("session_start", h.ctx());
	assert.equal(h.messages.length, 0);

	await h.emit("session_shutdown", h.ctx());
	t.mock.timers.tick(2 * MINUTE);

	assert.equal(h.messages.length, 0, "no reminder after cleanup");
	assert.equal(h.entries.length, 0);
	assert.equal(h.notifications.length, 0);
});

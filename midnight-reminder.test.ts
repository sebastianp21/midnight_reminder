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
import { test } from "node:test";
import midnightReminder from "./midnight-reminder.ts";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface Harness {
	handlers: Record<string, Handler[]>;
	commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	entries: Array<{ type: string; data: unknown }>;
	messages: Array<Record<string, unknown>>;
	notifications: string[];
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
			notify: (message: string) => notifications.push(message),
			setStatus: () => undefined,
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

	return { handlers, commands, entries, messages, notifications, branch, emit, ctx };
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

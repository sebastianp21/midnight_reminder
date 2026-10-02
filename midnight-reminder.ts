/**
 * Midnight Reminder — a gentle reminder to stop working.
 *
 * At a configured time (midnight, local time, by default) the extension
 * delivers a friendly nudge to wrap up for the night. If the agent happens
 * to be busy at that moment, the reminder is held and delivered as soon as
 * Pi becomes idle, so it never interrupts an in-flight turn.
 *
 * Load it for a single run:
 *   pi --extension ./midnight-reminder.ts
 *
 * Try it:
 *   /midnight now      -> show the reminder immediately
 *   /midnight status   -> next scheduled reminder
 *   /midnight off|on   -> toggle the schedule
 *
 * Environment variables:
 *   MIDNIGHT_REMINDER_TIME            "HH:MM" local time (default "00:00")
 *   MIDNIGHT_REMINDER_MESSAGE         custom reminder text
 *   MIDNIGHT_REMINDER_GRACE_MINUTES   catch-up window after start-up (default 120)
 *   MIDNIGHT_REMINDER_DISABLED=1      start with the schedule disabled
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type ReminderTime,
	dateKey,
	formatTimeOfDay,
	msUntilNext,
	parseTimeOfDay,
	shouldCatchUp,
} from "./midnight-schedule.ts";

const DEFAULT_TIME = "14:30";
const DEFAULT_GRACE_MINUTES = 120;
const DEFAULT_MESSAGE =
	"🌙 It's past midnight. The bugs will still be here tomorrow — so will you, hopefully well rested. Time to call it a night.";

const CUSTOM_TYPE = "midnight-reminder";

interface ReminderEntryData {
	/** Local YYYY-MM-DD on which the reminder was delivered. */
	deliveredOn: string;
	/** Configured time of day, for debugging persisted sessions. */
	time: string;
}

function envTime(): ReminderTime {
	const configured = process.env.MIDNIGHT_REMINDER_TIME ?? "";
	return (
		parseTimeOfDay(configured) ??
		parseTimeOfDay(DEFAULT_TIME) ?? { hours: 0, minutes: 0 }
	);
}

function envGraceMs(): number {
	const raw = Number(process.env.MIDNIGHT_REMINDER_GRACE_MINUTES);
	const minutes =
		Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GRACE_MINUTES;
	return minutes * 60_000;
}

function envMessage(): string {
	return process.env.MIDNIGHT_REMINDER_MESSAGE?.trim() || DEFAULT_MESSAGE;
}

function isEnvDisabled(): boolean {
	return process.env.MIDNIGHT_REMINDER_DISABLED === "1";
}

export default function (pi: ExtensionAPI) {
	const time = envTime();
	const graceMs = envGraceMs();
	const message = envMessage();

	let enabled = !isEnvDisabled();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let ctx: ExtensionContext | undefined;
	/** Reason a reminder is owed but waiting for the agent to become idle. */
	let pendingReason: string | null = null;
	/** Date on which the reminder was last delivered (dedupes per day). */
	let deliveredOn: string | null = null;

	const clearTimer = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const updateStatus = () => {
		if (!ctx?.hasUI) return;
		if (!enabled) {
			ctx.ui.setStatus(CUSTOM_TYPE, "🌙 reminder off");
			return;
		}
		const next = new Date(Date.now() + msUntilNext(time, new Date()));
		ctx.ui.setStatus(
			CUSTOM_TYPE,
			`🌙 next ${formatTimeOfDay(time)} (${next.toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			})})`,
		);
	};

	const deliver = (reason: string) => {
		if (!ctx) return;

		const today = dateKey(new Date());
		deliveredOn = today;
		pendingReason = null;

		pi.appendEntry<ReminderEntryData>(CUSTOM_TYPE, {
			deliveredOn: today,
			time: formatTimeOfDay(time),
		});
		// display-only custom message: the human sees it without triggering
		// another model turn (we want them to stop working, not keep going).
		pi.sendMessage({
			customType: CUSTOM_TYPE,
			content: message,
			display: true,
			details: { reason },
		});
		if (ctx.hasUI) ctx.ui.notify(message, "info");

		updateStatus();
	};

	const schedule = () => {
		clearTimer();
		if (!enabled) {
			updateStatus();
			return;
		}
		timer = setTimeout(onFire, msUntilNext(time, new Date()));
		// Never keep the Pi process alive just for the reminder.
		timer.unref?.();
		updateStatus();
	};

	const onFire = () => {
		timer = undefined;
		const today = dateKey(new Date());

		if (deliveredOn === today) {
			schedule();
			return;
		}

		if (ctx?.isIdle() ?? true) {
			deliver("scheduled");
		} else {
			// Hold the reminder until the current turn settles.
			pendingReason = "scheduled";
		}
		schedule();
	};

	pi.on("session_start", async (_event, sessionCtx) => {
		ctx = sessionCtx;
		pendingReason = null;

		// Restore the last delivery date for this branch so a reload or resume
		// does not fire the same night's reminder twice.
		deliveredOn = null;
		for (const entry of sessionCtx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as ReminderEntryData | undefined;
				if (data?.deliveredOn) deliveredOn = data.deliveredOn;
			}
		}

		const now = new Date();
		const today = dateKey(now);
		if (
			enabled &&
			deliveredOn !== today &&
			shouldCatchUp(time, now, graceMs)
		) {
			if (sessionCtx.isIdle()) deliver("catch-up");
			else pendingReason = "catch-up";
		}

		schedule();
	});

	pi.on("agent_settled", async (_event, settledCtx) => {
		ctx = settledCtx;
		if (pendingReason && enabled && settledCtx.isIdle()) {
			deliver(pendingReason);
		}
		updateStatus();
	});

	pi.on("session_shutdown", async () => {
		clearTimer();
		ctx = undefined;
		pendingReason = null;
	});

	pi.registerCommand("midnight", {
		description: "Midnight Reminder: show, inspect, or toggle the reminder",
		handler: async (args, commandCtx) => {
			ctx = commandCtx;
			const action = (args ?? "").trim().toLowerCase();

			switch (action) {
				case "":
				case "now":
					deliver("manual");
					commandCtx.ui.notify("Midnight reminder shown.", "info");
					break;
				case "status": {
					const next = new Date(Date.now() + msUntilNext(time, new Date()));
					const state = enabled ? "armed" : "disabled";
					commandCtx.ui.notify(
						`Midnight reminder is ${state}; next at ${formatTimeOfDay(time)} (${next.toLocaleString()}).`,
						"info",
					);
					break;
				}
				case "off":
					enabled = false;
					clearTimer();
					updateStatus();
					commandCtx.ui.notify("Midnight reminder disabled.", "info");
					break;
				case "on":
					enabled = true;
					schedule();
					commandCtx.ui.notify(
						`Midnight reminder armed for ${formatTimeOfDay(time)}.`,
						"info",
					);
					break;
				default:
					commandCtx.ui.notify("Usage: /midnight [now|status|on|off]", "warning");
			}
		},
	});
}

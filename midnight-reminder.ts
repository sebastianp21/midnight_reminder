/**
 * Midnight Reminder — a gentle reminder to stop working.
 *
 * During a configured local time window (00:00-06:00 by default) the
 * extension delivers a friendly nudge to wrap up for the night. If the agent
 * happens to be busy when the window opens, the reminder is held and
 * delivered as soon as Pi becomes idle, so it never interrupts an in-flight
 * turn.
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
 *   MIDNIGHT_REMINDER_FROM            "HH:MM" window start, local (default "00:00")
 *   MIDNIGHT_REMINDER_TO              "HH:MM" window end, local (default "06:00")
 *   MIDNIGHT_REMINDER_TIME            legacy alias for MIDNIGHT_REMINDER_FROM
 *   MIDNIGHT_REMINDER_GRACE_MINUTES   derive the window end from the start
 *   MIDNIGHT_REMINDER_MESSAGE         custom reminder text
 *   MIDNIGHT_REMINDER_DISABLED=1      start with the schedule disabled
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type ReminderWindow,
	addMinutes,
	dateKey,
	formatTimeOfDay,
	formatWindow,
	isWithinWindow,
	msUntilNext,
	parseTimeOfDay,
} from "./midnight-schedule.ts";
import { formatBedtimeReport, runBedtimeTest } from "./bedtime-demo.ts";

const DEFAULT_FROM = "00:00";
const DEFAULT_TO = "06:00";
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

function envWindow(): ReminderWindow {
	// `MIDNIGHT_REMINDER_TIME` is the legacy single-time variable and acts as
	// an alias for the window start.
	const fromInput =
		process.env.MIDNIGHT_REMINDER_FROM?.trim() ||
		process.env.MIDNIGHT_REMINDER_TIME?.trim() ||
		DEFAULT_FROM;
	const from = parseTimeOfDay(fromInput) ?? parseTimeOfDay(DEFAULT_FROM)!;

	const explicitTo = parseTimeOfDay(
		process.env.MIDNIGHT_REMINDER_TO?.trim() ?? "",
	);
	if (explicitTo) return { from, to: explicitTo };

	const graceInput = process.env.MIDNIGHT_REMINDER_GRACE_MINUTES?.trim();
	if (graceInput) {
		const raw = Number(graceInput);
		const minutes = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GRACE_MINUTES;
		return { from, to: addMinutes(from, minutes) };
	}

	return { from, to: parseTimeOfDay(DEFAULT_TO)! };
}

function envMessage(): string {
	return process.env.MIDNIGHT_REMINDER_MESSAGE?.trim() || DEFAULT_MESSAGE;
}

function isEnvDisabled(): boolean {
	return process.env.MIDNIGHT_REMINDER_DISABLED === "1";
}

export default function (pi: ExtensionAPI) {
	const window = envWindow();
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
		const next = new Date(Date.now() + msUntilNext(window.from, new Date()));
		ctx.ui.setStatus(
			CUSTOM_TYPE,
			`🌙 ${formatWindow(window)} (${next.toLocaleTimeString([], {
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
			time: formatTimeOfDay(window.from),
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
		timer = setTimeout(onFire, msUntilNext(window.from, new Date()));
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
		if (enabled && deliveredOn !== today && isWithinWindow(window, now)) {
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

	pi.registerCommand("bedtime-test", {
		description:
			"Run the reminder through simulated time and report pass/fail (no waiting for midnight)",
		handler: async (_args, commandCtx) => {
			// Always use the canonical 00:00-06:00 window so the demonstration is
			// deterministic regardless of the environment configuration.
			const result = runBedtimeTest({
				from: { hours: 0, minutes: 0 },
				to: { hours: 6, minutes: 0 },
			});
			const report = formatBedtimeReport(result, { message });

			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: report,
				display: true,
				details: { kind: "bedtime-test", passed: result.passed },
			});
			commandCtx.ui.notify(
				result.passed
					? "bedtime-test: all simulated-time checks passed ✅"
					: "bedtime-test: some checks failed ❌",
				result.passed ? "info" : "warning",
			);
		},
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
					const next = new Date(
						Date.now() + msUntilNext(window.from, new Date()),
					);
					const state = enabled ? "armed" : "disabled";
					commandCtx.ui.notify(
						`Midnight reminder is ${state}; window ${formatWindow(window)}; next opening at ${next.toLocaleString()}.`,
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
						`Midnight reminder armed for ${formatWindow(window)}.`,
						"info",
					);
					break;
				default:
					commandCtx.ui.notify("Usage: /midnight [now|status|on|off]", "warning");
			}
		},
	});
}

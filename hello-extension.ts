/**
 * Small example extension for Pi.
 *
 * Load it for a single run without installing anything:
 *   pi --extension ./hello-extension.ts
 *
 * Then try:
 *   /greet Ada          -> shows a notification
 *   ask the model to use the "word_count" tool
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 1. A model-callable tool.
const wordCount = defineTool({
	name: "word_count",
	label: "Word Count",
	description: "Count the words in a piece of text.",
	parameters: Type.Object({
		text: Type.String({ description: "Text whose words should be counted" }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const words = params.text.trim().split(/\s+/).filter(Boolean).length;
		return {
			content: [{ type: "text", text: `That text has ${words} word(s).` }],
			details: { words },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(wordCount);

	// 2. A slash command with a UI notification.
	pi.registerCommand("greet", {
		description: "Show a greeting",
		handler: async (name, ctx) => {
			ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
		},
	});

	// 3. A lifecycle hook.
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("hello-extension loaded", "info");
	});
}

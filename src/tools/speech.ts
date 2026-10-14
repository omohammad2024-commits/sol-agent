import type { Config } from "../config";
import { synthesize, ttsProvider } from "../tts";
import type { Tool } from "../types";

export const speak: Tool = {
  name: "speak",
  description: "Say something as a voice message in this chat (text-to-speech). Use when the user asks you to speak / send a voice. Keep the text under ~1500 characters.",
  level: "trusted",
  enabled: (c: Config) => ttsProvider(c) !== null,
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async run({ text }, ctx) {
    await ctx.sendVoice(await synthesize(ctx.config, text));
    return { sent: true };
  },
};

export const speechTools: Tool[] = [speak];

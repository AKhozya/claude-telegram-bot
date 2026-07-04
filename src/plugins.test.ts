import { test, expect } from "bun:test";
import { Bot, Api, Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { hydrateFiles, type FileFlavor, type FileApiFlavor } from "@grammyjs/files";

test("bot constructs with auto-retry + files transformers wired", () => {
  type C = FileFlavor<Context>;
  type A = FileApiFlavor<Api>;
  const bot = new Bot<C, A>("123:FAKE");
  // Wiring must not throw at install time.
  expect(() => {
    bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
    bot.api.config.use(hydrateFiles(bot.token));
  }).not.toThrow();
});

import { test, expect } from "bun:test";

test("downloadTelegramFile uses files-plugin .download(destPath) and returns it", async () => {
  const dest = "/tmp/telegram-bot/x.jpg";
  let got = "";
  const ctx: any = {
    message: { photo: [{ file_id: "a" }, { file_id: "b" }] },
    getFile: async () => ({
      download: async (p: string) => {
        got = p;
        return p;
      },
    }),
  };
  const { downloadTelegramFile } = await import("./download");
  const path = await downloadTelegramFile(ctx, dest);
  expect(path).toBe(dest);
  expect(got).toBe(dest);
});

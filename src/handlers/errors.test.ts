import { describe, expect, test } from "bun:test";

const { handleProcessingError } = await import("./errors");
const { StreamingState } = await import("./streaming");

describe("handleProcessingError tool-message cleanup", () => {
  test("every tool message is attempted even when one delete throws", async () => {
    const deleted: number[] = [];
    const reactions: string[] = [];
    const replies: string[] = [];
    const ctx: any = {
      chat: { id: 100 },
      msg: { message_id: 5 },
      reply: async (t: string) => {
        replies.push(t);
        return { chat: { id: 100 }, message_id: 900 };
      },
      api: {
        setMessageReaction: async (_c: number, _m: number, r: any[]) => {
          reactions.push(r[0].emoji);
        },
        deleteMessage: async (_c: number, id: number) => {
          // Recorded before the throw — see text.test.ts.
          deleted.push(id);
          if (id === 902) throw new Error("message to delete not found");
        },
      },
    };
    const state = new StreamingState();
    state.toolMessages = [901, 902, 903].map((id) => ({
      chat: { id: 100 },
      message_id: id,
    })) as any;

    await handleProcessingError(ctx, new Error("boom"), state);

    expect(deleted).toEqual([901, 902, 903]);
    expect(reactions).toEqual(["👎"]);
    expect(replies).toEqual(["❌ Error: Error: boom"]);
  });
});

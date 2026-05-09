import { beforeEach, describe, expect, it, vi } from "vitest";

const sendJsonRpcMock = vi.hoisted(() => vi.fn());
const resolveBeforeCallMock = vi.hoisted(() => vi.fn());
const runAfterCallMock = vi.hoisted(() => vi.fn());

vi.mock("./transport.js", () => ({
  sendJsonRpc: sendJsonRpcMock,
}));

vi.mock("./interceptors/index.js", () => ({
  resolveBeforeCall: resolveBeforeCallMock,
  runAfterCall: runAfterCallMock,
}));

import { createWeComMcpTool } from "./tool.js";

describe("createWeComMcpTool", () => {
  beforeEach(() => {
    sendJsonRpcMock.mockReset();
    resolveBeforeCallMock.mockReset();
    runAfterCallMock.mockReset();
    resolveBeforeCallMock.mockResolvedValue({});
    runAfterCallMock.mockImplementation(async (_ctx: unknown, result: unknown) => result);
  });

  it("passes trusted requester userid to tools/list requests", async () => {
    sendJsonRpcMock.mockResolvedValue({ tools: [] });

    const tool = createWeComMcpTool({ requesterUserId: "  wecom-user-1  " });
    await tool.execute("tool-call-1", {
      action: "list",
      category: "contact",
    });

    expect(sendJsonRpcMock).toHaveBeenCalledWith(
      "contact",
      "tools/list",
      undefined,
      { requesterUserId: "wecom-user-1" },
    );
  });

  it("merges interceptor options with trusted requester userid for tools/call", async () => {
    sendJsonRpcMock.mockResolvedValue({ ok: true });
    resolveBeforeCallMock.mockResolvedValue({
      options: { timeoutMs: 45_000 },
      args: { replaced: true },
    });

    const tool = createWeComMcpTool({ requesterUserId: "wecom-user-2" });
    await tool.execute("tool-call-2", {
      action: "call",
      category: "doc",
      method: "smartpage_create",
      args: JSON.stringify({ original: true }),
    });

    expect(sendJsonRpcMock).toHaveBeenCalledWith(
      "doc",
      "tools/call",
      {
        name: "smartpage_create",
        arguments: { replaced: true },
      },
      {
        timeoutMs: 45_000,
        requesterUserId: "wecom-user-2",
      },
    );
  });
});

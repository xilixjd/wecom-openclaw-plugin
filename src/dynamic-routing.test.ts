import { describe, expect, test } from "vitest";
import {
  buildAgentMainSessionKey,
  buildAgentSessionKey,
  deriveLastRoutePolicy,
} from "openclaw/plugin-sdk/routing";

import { processDynamicRouting } from "./dynamic-routing.js";

describe("dynamic routing", () => {
  test("uses SDK route helpers for dynamic agent session keys", () => {
    const route = {
      agentId: "wecom-first",
      sessionKey: "agent:wecom-first:main",
      mainSessionKey: "agent:wecom-first:main",
      lastRoutePolicy: "main" as const,
      matchedBy: "default" as const,
      accountId: "main",
    };

    const result = processDynamicRouting({
      route,
      config: {
        session: {
          dmScope: "per-account-channel-peer",
        },
        channels: {
          wecom: {
            dynamicAgents: {
              enabled: true,
              dmCreateAgent: true,
              groupEnabled: true,
            },
          },
        },
      } as any,
      core: {} as any,
      accountId: "main",
      chatType: "dm",
      chatId: "zhangsan",
      senderId: "zhangsan",
    });

    const expectedAgentId = "wecom-main-dm-zhangsan";
    const expectedSessionKey = buildAgentSessionKey({
      agentId: expectedAgentId,
      channel: "wecom",
      accountId: "main",
      peer: {
        kind: "direct",
        id: "zhangsan",
      },
      dmScope: "per-account-channel-peer",
    }).toLowerCase();
    const expectedMainSessionKey = buildAgentMainSessionKey({
      agentId: expectedAgentId,
    }).toLowerCase();

    expect(result.routeModified).toBe(true);
    expect(result.finalAgentId).toBe(expectedAgentId);
    expect(result.finalSessionKey).toBe(expectedSessionKey);
    expect(result.finalSessionKey).toContain(":direct:");
    expect(result.finalMainSessionKey).toBe(expectedMainSessionKey);
    expect(result.finalLastRoutePolicy).toBe(
      deriveLastRoutePolicy({
        sessionKey: expectedSessionKey,
        mainSessionKey: expectedMainSessionKey,
      }),
    );
  });

  test("keeps dynamic routing enabled for account-level bindings", () => {
    const route = {
      agentId: "wecom-first",
      sessionKey: "agent:wecom-first:main",
      mainSessionKey: "agent:wecom-first:main",
      lastRoutePolicy: "main" as const,
      matchedBy: "binding.account" as const,
      accountId: "main",
    };

    const result = processDynamicRouting({
      route,
      config: {
        session: {
          dmScope: "per-account-channel-peer",
        },
        channels: {
          wecom: {
            dynamicAgents: {
              enabled: true,
              dmCreateAgent: true,
              groupEnabled: true,
            },
          },
        },
      } as any,
      core: {} as any,
      accountId: "main",
      chatType: "dm",
      chatId: "zhangsan",
      senderId: "zhangsan",
    });

    const expectedAgentId = "wecom-main-dm-zhangsan";
    const expectedSessionKey = buildAgentSessionKey({
      agentId: expectedAgentId,
      channel: "wecom",
      accountId: "main",
      peer: {
        kind: "direct",
        id: "zhangsan",
      },
      dmScope: "per-account-channel-peer",
    }).toLowerCase();
    const expectedMainSessionKey = buildAgentMainSessionKey({
      agentId: expectedAgentId,
    }).toLowerCase();

    expect(result.routeModified).toBe(true);
    expect(result.finalAgentId).toBe(expectedAgentId);
    expect(result.finalSessionKey).toBe(expectedSessionKey);
    expect(result.finalMainSessionKey).toBe(expectedMainSessionKey);
    expect(result.finalLastRoutePolicy).toBe(
      deriveLastRoutePolicy({
        sessionKey: expectedSessionKey,
        mainSessionKey: expectedMainSessionKey,
      }),
    );
  });

  test("preserves main session metadata when peer-level binding is matched", () => {
    const route = {
      agentId: "wecom-first",
      sessionKey: "agent:wecom-first:main",
      mainSessionKey: "agent:wecom-first:main",
      lastRoutePolicy: "main" as const,
      matchedBy: "binding.peer" as const,
      accountId: "main",
    };

    const result = processDynamicRouting({
      route,
      config: {} as any,
      core: {} as any,
      accountId: "main",
      chatType: "dm",
      chatId: "zhangsan",
      senderId: "zhangsan",
    });

    expect(result.routeModified).toBe(false);
    expect(result.finalSessionKey).toBe(route.sessionKey);
    expect(result.finalMainSessionKey).toBe(route.mainSessionKey);
    expect(result.finalLastRoutePolicy).toBe(route.lastRoutePolicy);
  });
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ensureDynamicAgentConfigured,
  prepareDynamicAgentRuntime,
} from "./dynamic-agent.js";

const root = path.join("/tmp", `wecom-dynamic-agent-${process.pid}`);

function createConfig() {
  return {
    agents: {
      defaults: {
        workspace: path.join(root, "workspace-first"),
      },
      list: [
        {
          id: "wecom-first",
          default: true,
          workspace: path.join(root, "workspace-first"),
          tools: {
            alsoAllow: ["wecom_mcp"],
          },
        },
      ],
    },
    channels: {
      wecom: {
        dynamicAgents: {
          enabled: true,
          dmCreateAgent: true,
          groupEnabled: true,
          workspaceSeed: true,
        },
      },
    },
  } as any;
}

function createRuntime() {
  return {
    agent: {
      resolveAgentDir: (_cfg: unknown, agentId: string) =>
        path.join(root, "agents", agentId, "agent"),
      // Simulate the current nested-path behavior unless the plugin explicitly
      // registers a standalone workspace for the dynamic agent first.
      resolveAgentWorkspaceDir: (cfg: any, agentId: string) => {
        const normalized = String(agentId).trim().toLowerCase();
        const entry = (cfg?.agents?.list ?? []).find(
          (candidate: any) =>
            String(candidate?.id ?? "").trim().toLowerCase() === normalized,
        );
        if (typeof entry?.workspace === "string" && entry.workspace.trim()) {
          return entry.workspace;
        }
        if (normalized === "wecom-first") {
          return path.join(root, "workspace-first");
        }
        return path.join(root, "workspace-first", normalized);
      },
    },
  } as any;
}

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("dynamic-agent runtime workspace", () => {
  test("registers a standalone workspace for the dynamic agent", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const cfg = createConfig();
    const runtime = createRuntime();

    const workspaceDir = ensureDynamicAgentConfigured({
      dynamicAgentId: "wecom-default-dm-chuigeqiqiu",
      sourceAgentId: "wecom-first",
      config: cfg,
      runtime,
    });

    expect(workspaceDir).toBe(
      path.join(root, "workspace-wecom-default-dm-chuigeqiqiu"),
    );
    expect(cfg.agents.list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "wecom-default-dm-chuigeqiqiu",
          workspace: path.join(root, "workspace-wecom-default-dm-chuigeqiqiu"),
          default: false,
        }),
      ]),
    );
    const dynamicEntry = cfg.agents.list.find(
      (entry: any) => entry?.id === "wecom-default-dm-chuigeqiqiu",
    );
    expect(dynamicEntry?.tools).toBeUndefined();
  });

  test("seeds the standalone workspace instead of nesting under the source workspace", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const cfg = createConfig();
    const runtime = createRuntime();

    fs.mkdirSync(path.join(root, "workspace-first", "skills", "demo-skill"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, "workspace-first", "AGENTS.md"), "base agents");
    fs.writeFileSync(
      path.join(root, "workspace-first", "skills", "demo-skill", "SKILL.md"),
      "demo",
    );

    prepareDynamicAgentRuntime({
      dynamicAgentId: "wecom-default-dm-chuigeqiqiu",
      sourceAgentId: "wecom-first",
      config: cfg,
      runtime,
    });

    expect(
      fs.existsSync(
        path.join(root, "workspace-wecom-default-dm-chuigeqiqiu", "AGENTS.md"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(root, "workspace-wecom-default-dm-chuigeqiqiu", ".seeded"),
      ),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(
          root,
          "workspace-wecom-default-dm-chuigeqiqiu",
          "skills",
          "demo-skill",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).toBe("demo");
    expect(
      fs.existsSync(
        path.join(root, "workspace-first", "wecom-default-dm-chuigeqiqiu"),
      ),
    ).toBe(false);
  });

  test("derives the dynamic workspace beside the source workspace instead of hardcoding stateDir", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "some-other-state-root"));

    const customBase = path.join(root, "custom-openclaw-home");
    const cfg = {
      agents: {
        list: [
          {
            id: "wecom-first",
            default: true,
            workspace: path.join(customBase, "workspace-first"),
          },
        ],
      },
      channels: {
        wecom: {
          dynamicAgents: {
            enabled: true,
            dmCreateAgent: true,
            groupEnabled: true,
            workspaceSeed: false,
          },
        },
      },
    } as any;

    const runtime = {
      agent: {
        resolveAgentDir: (_cfg: unknown, agentId: string) =>
          path.join(customBase, "agents", agentId, "agent"),
        resolveAgentWorkspaceDir: (runtimeCfg: any, agentId: string) => {
          const normalized = String(agentId).trim().toLowerCase();
          const entry = (runtimeCfg?.agents?.list ?? []).find(
            (candidate: any) =>
              String(candidate?.id ?? "").trim().toLowerCase() === normalized,
          );
          return entry?.workspace ?? path.join(customBase, "workspace-first", normalized);
        },
      },
    } as any;

    const workspaceDir = ensureDynamicAgentConfigured({
      dynamicAgentId: "wecom-default-dm-chuigeqiqiu",
      sourceAgentId: "wecom-first",
      config: cfg,
      runtime,
    });

    expect(workspaceDir).toBe(
      path.join(customBase, "workspace-wecom-default-dm-chuigeqiqiu"),
    );
    expect(workspaceDir).not.toContain(path.join(root, "some-other-state-root"));
  });
});

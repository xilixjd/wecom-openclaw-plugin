import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildDynamicAgentInboundBody,
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
      // Mirror the current OpenClaw core workspace resolution rules.
      resolveAgentWorkspaceDir: (cfg: any, agentId: string) => {
        const normalized = String(agentId).trim().toLowerCase();
        const entry = (cfg?.agents?.list ?? []).find(
          (candidate: any) =>
            String(candidate?.id ?? "").trim().toLowerCase() === normalized,
        );
        if (typeof entry?.workspace === "string" && entry.workspace.trim()) {
          return entry.workspace;
        }

        const defaultsWorkspace = String(cfg?.agents?.defaults?.workspace ?? "").trim();
        const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
        const defaultEntry = list.find((candidate: any) => candidate?.default) ?? list[0];
        const defaultAgentId = String(defaultEntry?.id ?? "main").trim().toLowerCase();

        if (!normalized || normalized === defaultAgentId) {
          return defaultsWorkspace || path.join(root, "workspace");
        }

        if (defaultsWorkspace) {
          return path.join(defaultsWorkspace, normalized);
        }

        return path.join(root, `workspace-${normalized}`);
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

    expect(workspaceDir).toBe(path.join(root, "workspace-wecom-default-dm-chuigeqiqiu"));
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

  test("derives the dynamic workspace from stateDir even when defaults.workspace is set", () => {
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

    const runtime = createRuntime();

    const workspaceDir = ensureDynamicAgentConfigured({
      dynamicAgentId: "wecom-default-dm-chuigeqiqiu",
      sourceAgentId: "wecom-first",
      config: cfg,
      runtime,
    });

    expect(workspaceDir).toBe(path.join(root, "some-other-state-root", "workspace-wecom-default-dm-chuigeqiqiu"));
    expect(workspaceDir).not.toContain(customBase);
  });

  test("includes added skill description in the next runtime note", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const cfg = createConfig();
    const runtime = createRuntime();

    fs.mkdirSync(path.join(root, "workspace-first"), { recursive: true });
    fs.mkdirSync(path.join(root, "workspace-first", "skills"), { recursive: true });
    fs.writeFileSync(path.join(root, "workspace-first", "AGENTS.md"), "base agents");

    prepareDynamicAgentRuntime({
      dynamicAgentId: "wecom-default-dm-noteuser",
      sourceAgentId: "wecom-first",
      config: cfg,
      runtime,
    });

    const stagingSkillDir = path.join(root, "staging-added-skill");
    fs.mkdirSync(stagingSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagingSkillDir, "SKILL.md"),
      ["---", "name: added-skill", "description: Added skill description", "---", "", "body"].join("\n"),
    );
    fs.renameSync(
      stagingSkillDir,
      path.join(root, "workspace-wecom-default-dm-noteuser", "skills", "added-skill"),
    );

    await vi.waitFor(() => {
      const normalResult = buildDynamicAgentInboundBody({
        agentId: "wecom-default-dm-noteuser",
        commandBody: "hello",
        isCommand: false,
      });
      expect(normalResult.modelInputBody).toContain("added: added-skill");
      expect(normalResult.modelInputBody).toContain("description: Added skill description");
      expect(normalResult.modelInputBody).toContain("hello");
    });
  });

  test("includes removed skill in the next runtime note", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const cfg = createConfig();
    const runtime = createRuntime();

    fs.mkdirSync(path.join(root, "workspace-first", "skills", "remove-me"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, "workspace-first", "AGENTS.md"), "base agents");
    fs.writeFileSync(
      path.join(root, "workspace-first", "skills", "remove-me", "SKILL.md"),
      ["---", "name: remove-me", "description: Remove me", "---", "", "body"].join("\n"),
    );

    prepareDynamicAgentRuntime({
      dynamicAgentId: "wecom-default-dm-remove-noteuser",
      sourceAgentId: "wecom-first",
      config: cfg,
      runtime,
    });

    fs.rmSync(
      path.join(root, "workspace-wecom-default-dm-remove-noteuser", "skills", "remove-me"),
      { recursive: true, force: true },
    );

    await vi.waitFor(() => {
      const normalResult = buildDynamicAgentInboundBody({
        agentId: "wecom-default-dm-remove-noteuser",
        commandBody: "hello",
        isCommand: false,
      });
      expect(normalResult.modelInputBody).toContain("removed: remove-me");
      expect(normalResult.modelInputBody).toContain("hello");
    });
  });

  test("does not emit added notes for pre-existing skills after startup", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const cfg = createConfig();
    const runtime = createRuntime();

    fs.mkdirSync(path.join(root, "workspace-first", "skills", "existing-skill"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, "workspace-first", "AGENTS.md"), "base agents");
    fs.writeFileSync(
      path.join(root, "workspace-first", "skills", "existing-skill", "SKILL.md"),
      ["---", "name: existing-skill", "description: Existing", "---", "", "body"].join("\n"),
    );

    prepareDynamicAgentRuntime({
      dynamicAgentId: "wecom-default-dm-existing-noteuser",
      sourceAgentId: "wecom-first",
      config: cfg,
      runtime,
    });

    const normalResult = buildDynamicAgentInboundBody({
      agentId: "wecom-default-dm-existing-noteuser",
      commandBody: "hello",
      isCommand: false,
    });
    expect(normalResult.modelInputBody).toBe("hello");
  });

  test("includes updated skill in the next runtime note", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const cfg = createConfig();
    const runtime = createRuntime();

    fs.mkdirSync(path.join(root, "workspace-first", "skills", "update-me"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, "workspace-first", "AGENTS.md"), "base agents");
    fs.writeFileSync(
      path.join(root, "workspace-first", "skills", "update-me", "SKILL.md"),
      ["---", "name: update-me", "description: before", "---", "", "body"].join("\n"),
    );

    prepareDynamicAgentRuntime({
      dynamicAgentId: "wecom-default-dm-update-noteuser",
      sourceAgentId: "wecom-first",
      config: cfg,
      runtime,
    });

    const warmup = buildDynamicAgentInboundBody({
      agentId: "wecom-default-dm-update-noteuser",
      commandBody: "warmup",
      isCommand: false,
    });
    expect(warmup.modelInputBody).toBe("warmup");

    fs.writeFileSync(
      path.join(root, "workspace-wecom-default-dm-update-noteuser", "skills", "update-me", "SKILL.md"),
      ["---", "name: update-me", "description: after", "---", "", "body updated"].join("\n"),
    );

    await vi.waitFor(() => {
      const normalResult = buildDynamicAgentInboundBody({
        agentId: "wecom-default-dm-update-noteuser",
        commandBody: "hello",
        isCommand: false,
      });
      expect(normalResult.modelInputBody).toContain("updated: update-me");
      expect(normalResult.modelInputBody).toContain("hello");
    });
  });
});

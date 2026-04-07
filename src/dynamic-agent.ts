/**
 * **动态 Agent 路由模块**
 *
 * 为每个用户/群组自动生成独立的 Agent ID，实现会话隔离。
 * 参考: openclaw-plugin-wecom/dynamic-agent.js
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveStateDir } from "./state-dir-resolve.js";

export interface DynamicAgentConfig {
    enabled: boolean;
    dmCreateAgent: boolean;
    groupEnabled: boolean;
    adminUsers: string[];
    workspaceSeed: boolean;
}

/**
 * **getDynamicAgentConfig (读取动态 Agent 配置)**
 *
 * 从全局配置中读取动态 Agent 配置，提供默认值。
 */
export function getDynamicAgentConfig(config: OpenClawConfig): DynamicAgentConfig {
    const dynamicAgents = (config as { channels?: { wecom?: { dynamicAgents?: Partial<DynamicAgentConfig> } } })?.channels?.wecom?.dynamicAgents;
    return {
        enabled: dynamicAgents?.enabled ?? false,
        dmCreateAgent: dynamicAgents?.dmCreateAgent ?? true,
        groupEnabled: dynamicAgents?.groupEnabled ?? true,
        adminUsers: dynamicAgents?.adminUsers ?? [],
        workspaceSeed: dynamicAgents?.workspaceSeed ?? false,
    };
}

function sanitizeDynamicIdPart(value: string): string {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_");
}

/**
 * **generateAgentId (生成动态 Agent ID)**
 *
 * 根据账号 + 聊天类型 + 对端 ID 生成确定性的 Agent ID，避免多账号串会话。
 * 格式: wecom-{accountId}-{type}-{sanitizedPeerId}
 */
export function generateAgentId(chatType: "dm" | "group", peerId: string, accountId?: string): string {
    const sanitizedPeer = sanitizeDynamicIdPart(peerId) || "unknown";
    const sanitizedAccountId = sanitizeDynamicIdPart(accountId ?? "default") || "default";
    return `wecom-${sanitizedAccountId}-${chatType}-${sanitizedPeer}`;
}

/**
 * **shouldUseDynamicAgent (检查是否使用动态 Agent)**
 *
 * 根据配置和发送者信息判断是否应使用动态 Agent。
 * 管理员（adminUsers）始终绕过动态路由，使用主 Agent。
 */
export function shouldUseDynamicAgent(params: {
    chatType: "dm" | "group";
    senderId: string;
    config: OpenClawConfig;
}): boolean {
    const { chatType, senderId, config } = params;
    const dynamicConfig = getDynamicAgentConfig(config);

    if (!dynamicConfig.enabled) {
        return false;
    }

    // 管理员绕过动态路由
    const sender = String(senderId).trim().toLowerCase();
    const isAdmin = dynamicConfig.adminUsers.some(
        (admin) => admin.trim().toLowerCase() === sender
    );
    if (isAdmin) {
        return false;
    }

    if (chatType === "group") {
        return dynamicConfig.groupEnabled;
    }
    return dynamicConfig.dmCreateAgent;
}

type DynamicLogger = (message: string, ...args: unknown[]) => void;

type DynamicSkillDelta = {
    skillName: string;
    changeType: "added" | "updated" | "removed";
    skillFilePath: string;
};

type DynamicSkillsDeltaState = {
    changes: Map<string, DynamicSkillDelta>;
};

const DYNAMIC_WORKSPACE_STANDARD_FILES = [
    "AGENTS.md",
    "SOUL.md",
    "TOOLS.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "BOOTSTRAP.md",
] as const;

const dynamicSkillsRootWatchers = new Map<string, fs.FSWatcher>();
const dynamicSkillsChildWatchers = new Map<string, Map<string, fs.FSWatcher>>();
const dynamicSkillsWorkspaceDirs = new Map<string, string>();
const dynamicSkillsDeltaState = new Map<string, DynamicSkillsDeltaState>();

function resolveAgentDir(runtime: PluginRuntime, config: OpenClawConfig, agentId: string): string {
    try {
        const resolved = runtime.agent?.resolveAgentDir?.(config, agentId);
        if (typeof resolved === "string" && resolved.trim()) {
            return path.resolve(resolved);
        }
    } catch {
        // Fallback to state-dir derived path below.
    }
    return path.join(resolveStateDir(), "agents", agentId, "agent");
}

export function resolveAgentWorkspaceDir(
    runtime: PluginRuntime,
    config: OpenClawConfig,
    agentId: string,
): string {
    try {
        const resolved = runtime.agent?.resolveAgentWorkspaceDir?.(config, agentId);
        if (typeof resolved === "string" && resolved.trim()) {
            return path.resolve(resolved);
        }
    } catch {
        // Fallback to state-dir derived path below.
    }

    const normalizedAgentId = String(agentId).trim().toLowerCase();
    if (!normalizedAgentId || normalizedAgentId === "main") {
        return path.join(resolveStateDir(), "workspace");
    }
    return path.join(resolveStateDir(), `workspace-${normalizedAgentId}`);
}

function resolveSourceWorkspaceCandidates(
    runtime: PluginRuntime,
    config: OpenClawConfig,
    sourceAgentId: string,
): string[] {
    const candidates: string[] = [];
    const stateDir = resolveStateDir();

    try {
        const resolved = resolveAgentWorkspaceDir(runtime, config, sourceAgentId);
        if (resolved) {
            candidates.push(resolved);
        }
    } catch {
        // Keep fallback candidates.
    }

    candidates.push(path.join(stateDir, `workspace-${sourceAgentId}`));
    candidates.push(path.join(stateDir, "workspace"));

    const deduped = new Set<string>();
    for (const candidate of candidates) {
        deduped.add(path.resolve(candidate));
    }
    return [...deduped];
}

function recordDynamicSkillDelta(
    agentId: string,
    skillName: string,
    changeType: "added" | "updated" | "removed",
    skillFilePath: string,
): void {
    const existing = dynamicSkillsDeltaState.get(agentId) ?? {
        changes: new Map<string, DynamicSkillDelta>(),
    };
    existing.changes.set(skillName, { skillName, changeType, skillFilePath });
    dynamicSkillsDeltaState.set(agentId, existing);
}

function noteDynamicSkillFileChange(agentId: string, skillDir: string): void {
    const skillName = path.basename(skillDir);
    const skillFilePath = path.join(skillDir, "SKILL.md");
    const exists = fs.existsSync(skillFilePath);
    recordDynamicSkillDelta(agentId, skillName, exists ? "updated" : "removed", skillFilePath);
}

export function consumeDynamicSkillsDeltaNote(agentId: string): string | undefined {
    const state = dynamicSkillsDeltaState.get(agentId);
    if (!state || state.changes.size === 0) {
        return undefined;
    }

    const lines = [
        "[Runtime note: workspace skills changed]",
        "The following workspace skills changed recently. Any earlier conversation about them may be stale.",
    ];

    for (const change of state.changes.values()) {
        lines.push(`- ${change.changeType}: ${change.skillName} (${change.skillFilePath})`);
    }
    lines.push("If the current task may use one of these skills, re-read the listed SKILL.md before relying on it.");

    dynamicSkillsDeltaState.delete(agentId);
    return lines.join("\n");
}

export function buildDynamicAgentInboundBody(params: {
    agentId: string;
    commandBody: string;
    isCommand: boolean;
}): { commandBody: string; modelInputBody: string } {
    const { agentId, commandBody, isCommand } = params;
    if (isCommand) {
        return { commandBody, modelInputBody: commandBody };
    }

    const skillsDeltaNote = consumeDynamicSkillsDeltaNote(agentId);
    if (!skillsDeltaNote) {
        return { commandBody, modelInputBody: commandBody };
    }

    return {
        commandBody,
        modelInputBody: [skillsDeltaNote, "", commandBody].join("\n"),
    };
}

function watchSkillChildDir(params: {
    agentId: string;
    childDir: string;
    error?: DynamicLogger;
}): void {
    const { agentId, childDir } = params;
    let watchers = dynamicSkillsChildWatchers.get(agentId);
    if (!watchers) {
        watchers = new Map<string, fs.FSWatcher>();
        dynamicSkillsChildWatchers.set(agentId, watchers);
    }
    if (watchers.has(childDir) || !fs.existsSync(childDir)) {
        return;
    }

    try {
        const watcher = fs.watch(childDir, (_eventType, fileName) => {
            if (!fileName || String(fileName) === "SKILL.md") {
                noteDynamicSkillFileChange(agentId, childDir);
            }
        });
        watcher.on("error", (err) => {
            params.error?.(`[wecom][dynamic] skills child watcher error for ${agentId}: ${String(err)}`);
        });
        watchers.set(childDir, watcher);
    } catch (err) {
        params.error?.(`[wecom][dynamic] failed to watch skills dir ${childDir}: ${String(err)}`);
    }
}

function syncDynamicSkillsChildWatchers(params: {
    agentId: string;
    skillsDir: string;
    includeAdds: boolean;
    error?: DynamicLogger;
}): void {
    const active = dynamicSkillsChildWatchers.get(params.agentId) ?? new Map<string, fs.FSWatcher>();
    const nextDirs = new Set<string>();

    if (fs.existsSync(params.skillsDir)) {
        try {
            const entries = fs.readdirSync(params.skillsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const childDir = path.join(params.skillsDir, entry.name);
                nextDirs.add(childDir);
                if (!active.has(childDir)) {
                    watchSkillChildDir({
                        agentId: params.agentId,
                        childDir,
                        error: params.error,
                    });
                    const skillFilePath = path.join(childDir, "SKILL.md");
                    if (params.includeAdds && fs.existsSync(skillFilePath)) {
                        recordDynamicSkillDelta(params.agentId, entry.name, "added", skillFilePath);
                    }
                }
            }
        } catch (err) {
            params.error?.(`[wecom][dynamic] failed to scan skills dir ${params.skillsDir}: ${String(err)}`);
        }
    }

    for (const [childDir, watcher] of active) {
        if (nextDirs.has(childDir)) {
            continue;
        }
        watcher.close();
        active.delete(childDir);
        recordDynamicSkillDelta(
            params.agentId,
            path.basename(childDir),
            "removed",
            path.join(childDir, "SKILL.md"),
        );
    }
    dynamicSkillsChildWatchers.set(params.agentId, active);
}

function ensureDynamicSkillsWatcher(params: {
    agentId: string;
    workspaceDir: string;
    error?: DynamicLogger;
}): void {
    const normalizedWorkspaceDir = path.resolve(params.workspaceDir);
    const existingWorkspaceDir = dynamicSkillsWorkspaceDirs.get(params.agentId);
    if (existingWorkspaceDir && existingWorkspaceDir !== normalizedWorkspaceDir) {
        dynamicSkillsRootWatchers.get(params.agentId)?.close();
        dynamicSkillsRootWatchers.delete(params.agentId);

        const childWatchers = dynamicSkillsChildWatchers.get(params.agentId);
        if (childWatchers) {
            for (const watcher of childWatchers.values()) {
                watcher.close();
            }
            dynamicSkillsChildWatchers.delete(params.agentId);
        }
    }

    dynamicSkillsWorkspaceDirs.set(params.agentId, normalizedWorkspaceDir);
    const skillsDir = path.join(normalizedWorkspaceDir, "skills");
    if (!fs.existsSync(skillsDir)) {
        return;
    }

    if (!dynamicSkillsRootWatchers.has(params.agentId)) {
        try {
            const watcher = fs.watch(skillsDir, (_eventType, fileName) => {
                syncDynamicSkillsChildWatchers({
                    agentId: params.agentId,
                    skillsDir,
                    includeAdds: true,
                    error: params.error,
                });
                if (!fileName || String(fileName) === "SKILL.md") {
                    recordDynamicSkillDelta(
                        params.agentId,
                        "(workspace-root)",
                        "updated",
                        path.join(skillsDir, "SKILL.md"),
                    );
                }
            });
            watcher.on("error", (err) => {
                params.error?.(`[wecom][dynamic] skills root watcher error for ${params.agentId}: ${String(err)}`);
            });
            dynamicSkillsRootWatchers.set(params.agentId, watcher);
        } catch (err) {
            params.error?.(`[wecom][dynamic] failed to watch skills root ${skillsDir}: ${String(err)}`);
            return;
        }
    }

    syncDynamicSkillsChildWatchers({
        agentId: params.agentId,
        skillsDir,
        includeAdds: false,
        error: params.error,
    });
}

function copyFileIfMissing(srcPath: string, destPath: string, error?: DynamicLogger): boolean {
    if (!fs.existsSync(srcPath) || fs.existsSync(destPath)) {
        return false;
    }
    try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
        return false;
    } catch (err) {
        error?.(`[wecom][dynamic] failed to copy file "${srcPath}" -> "${destPath}": ${String(err)}`);
        return true;
    }
}

function copyDirRecursiveIfMissing(srcDir: string, destDir: string, error?: DynamicLogger): boolean {
    let hadError = false;
    let entries: fs.Dirent[] = [];

    try {
        entries = fs.readdirSync(srcDir, { withFileTypes: true });
    } catch (err) {
        error?.(`[wecom][dynamic] failed to read dir "${srcDir}": ${String(err)}`);
        return true;
    }

    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            try {
                fs.mkdirSync(destPath, { recursive: true });
            } catch (err) {
                hadError = true;
                error?.(`[wecom][dynamic] failed to create dir "${destPath}": ${String(err)}`);
                continue;
            }
            hadError = copyDirRecursiveIfMissing(srcPath, destPath, error) || hadError;
            continue;
        }
        if (entry.isFile()) {
            hadError = copyFileIfMissing(srcPath, destPath, error) || hadError;
        }
    }
    return hadError;
}

export function ensureDynamicAgentWorkspace(params: {
    dynamicAgentId: string;
    sourceAgentId: string;
    config: OpenClawConfig;
    runtime: PluginRuntime;
    log?: DynamicLogger;
    error?: DynamicLogger;
}): void {
    const dynamicAgentId = String(params.dynamicAgentId).trim().toLowerCase();
    if (!dynamicAgentId) {
        return;
    }
    const sourceAgentId = String(params.sourceAgentId).trim().toLowerCase() || "main";

    const targetAgentDir = resolveAgentDir(params.runtime, params.config, dynamicAgentId);
    const targetWorkspace = resolveAgentWorkspaceDir(params.runtime, params.config, dynamicAgentId);
    const seedMarker = path.join(targetWorkspace, ".seeded");

    try {
        fs.mkdirSync(targetAgentDir, { recursive: true });
        fs.mkdirSync(targetWorkspace, { recursive: true });
    } catch (err) {
        params.error?.(
            `[wecom][dynamic] failed to initialize dirs for "${dynamicAgentId}": ${String(err)}`,
        );
        return;
    }

    if (!fs.existsSync(seedMarker)) {
        const candidates = resolveSourceWorkspaceCandidates(params.runtime, params.config, sourceAgentId);
        const sourceWorkspace = candidates.find((candidate) => fs.existsSync(candidate));
        if (sourceWorkspace) {
            let seedFailed = false;
            for (const file of DYNAMIC_WORKSPACE_STANDARD_FILES) {
                seedFailed =
                    copyFileIfMissing(
                        path.join(sourceWorkspace, file),
                        path.join(targetWorkspace, file),
                        params.error,
                    ) || seedFailed;
            }

            const sourceSkillsDir = path.join(sourceWorkspace, "skills");
            if (fs.existsSync(sourceSkillsDir)) {
                const targetSkillsDir = path.join(targetWorkspace, "skills");
                try {
                    fs.mkdirSync(targetSkillsDir, { recursive: true });
                    seedFailed =
                        copyDirRecursiveIfMissing(sourceSkillsDir, targetSkillsDir, params.error) || seedFailed;
                } catch (err) {
                    seedFailed = true;
                    params.error?.(
                        `[wecom][dynamic] failed to prepare target skills dir "${targetSkillsDir}": ${String(err)}`,
                    );
                }
            }

            if (!seedFailed) {
                try {
                    fs.writeFileSync(seedMarker, new Date().toISOString());
                    params.log?.(
                        `[wecom][dynamic] seeded workspace for ${dynamicAgentId} from ${sourceWorkspace}`,
                    );
                } catch (err) {
                    params.error?.(
                        `[wecom][dynamic] failed to write seed marker "${seedMarker}": ${String(err)}`,
                    );
                }
            }
        } else {
            params.error?.(
                `[wecom][dynamic] no source workspace found for "${sourceAgentId}", candidates=${JSON.stringify(candidates)}`,
            );
        }
    }

    ensureDynamicSkillsWatcher({
        agentId: dynamicAgentId,
        workspaceDir: targetWorkspace,
        error: params.error,
    });
}

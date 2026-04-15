/**
 * **动态 Agent 路由模块**
 *
 * 为每个用户/群组自动生成独立的 Agent ID，实现会话隔离。
 * 参考: openclaw-plugin-wecom/dynamic-agent.js
 */

import fs from "node:fs";
import os from "node:os";
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
    skillDescription?: string;
};

type DynamicSkillsDeltaState = {
    changes: Map<string, DynamicSkillDelta>;
};

type DynamicSkillSnapshot = {
    skillName: string;
    skillDir: string;
    skillFilePath: string;
    signature: string;
};

type MutableAgentEntry = {
    id?: string;
    workspace?: string;
    default?: boolean;
    [key: string]: unknown;
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

const dynamicSkillsWorkspaceDirs = new Map<string, string>();
const dynamicSkillsDeltaState = new Map<string, DynamicSkillsDeltaState>();
const dynamicSkillsSnapshotState = new Map<string, Map<string, DynamicSkillSnapshot>>();

function normalizeAgentId(agentId: string): string {
    return String(agentId).trim().toLowerCase();
}

function resolveDefaultAgentIdFromConfig(config: OpenClawConfig): string {
    const list = Array.isArray((config as { agents?: { list?: MutableAgentEntry[] } })?.agents?.list)
        ? (config as { agents?: { list?: MutableAgentEntry[] } }).agents?.list ?? []
        : [];
    if (list.length === 0) {
        return "main";
    }

    const defaultEntry = list.find((entry) => entry?.default) ?? list[0];
    const normalized = normalizeAgentId(String(defaultEntry?.id ?? "main"));
    return normalized || "main";
}

function resolveDefaultWorkspaceRoot(config: OpenClawConfig): string | undefined {
    const configured = (config as { agents?: { defaults?: { workspace?: string } } })?.agents?.defaults?.workspace;
    if (typeof configured !== "string" || !configured.trim()) {
        return undefined;
    }

    const expanded = configured.trim().replace(/^~(?=\/|$)/, os.homedir());
    return path.resolve(expanded);
}

function resolveAgentWorkspaceFallbackDir(config: OpenClawConfig, agentId: string): string {
    const normalizedAgentId = normalizeAgentId(agentId);
    const defaultWorkspaceRoot = resolveDefaultWorkspaceRoot(config);
    const defaultAgentId = resolveDefaultAgentIdFromConfig(config);

    if (!normalizedAgentId || normalizedAgentId === defaultAgentId) {
        return defaultWorkspaceRoot ?? path.join(resolveStateDir(), "workspace");
    }

    if (defaultWorkspaceRoot) {
        return path.join(defaultWorkspaceRoot, normalizedAgentId);
    }

    return path.join(resolveStateDir(), `workspace-${normalizedAgentId}`);
}

function buildDynamicWorkspaceDir(params: {
    agentId: string;
}): string {
    const normalizedAgentId = normalizeAgentId(params.agentId) || "unknown";
    return path.join(resolveStateDir(), `workspace-${normalizedAgentId}`);
}

function buildDynamicAgentEntry(params: {
    dynamicAgentId: string;
    workspaceDir: string;
}): MutableAgentEntry {
    return {
        id: params.dynamicAgentId,
        workspace: params.workspaceDir,
        default: false,
    };
}

export function ensureDynamicAgentConfigured(params: {
    dynamicAgentId: string;
    sourceAgentId: string;
    config: OpenClawConfig;
    runtime: PluginRuntime;
    log?: DynamicLogger;
}): string {
    void params.sourceAgentId;
    void params.runtime;
    const dynamicAgentId = String(params.dynamicAgentId).trim().toLowerCase();
    if (!dynamicAgentId) {
        return buildDynamicWorkspaceDir({
            agentId: "unknown",
        });
    }

    const workspaceDir = buildDynamicWorkspaceDir({
        agentId: dynamicAgentId,
    });
    const cfg = params.config as OpenClawConfig & {
        agents?: {
            list?: MutableAgentEntry[];
        };
    };

    if (!cfg.agents || typeof cfg.agents !== "object") {
        cfg.agents = {};
    }

    if (!Array.isArray(cfg.agents.list)) {
        cfg.agents.list = [];
    }

    const nextEntry = buildDynamicAgentEntry({
        dynamicAgentId,
        workspaceDir,
    });

    const existingIndex = cfg.agents.list.findIndex(
        (entry) => String(entry?.id ?? "").trim().toLowerCase() === dynamicAgentId,
    );

    if (existingIndex < 0) {
        cfg.agents.list.push(nextEntry);
        params.log?.(
            `[wecom][dynamic] runtime agent entry prepared for ${dynamicAgentId} workspace=${workspaceDir}`,
        );
        return workspaceDir;
    }

    const existingEntry = cfg.agents.list[existingIndex];
    if (
        String(existingEntry?.workspace ?? "").trim() !== workspaceDir ||
        existingEntry?.default !== false
    ) {
        cfg.agents.list[existingIndex] = {
            ...existingEntry,
            ...nextEntry,
        };
        params.log?.(
            `[wecom][dynamic] runtime agent entry refreshed for ${dynamicAgentId} workspace=${workspaceDir}`,
        );
    }

    return workspaceDir;
}

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

    return resolveAgentWorkspaceFallbackDir(config, agentId);
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
    skillDescription?: string,
): void {
    const existing = dynamicSkillsDeltaState.get(agentId) ?? {
        changes: new Map<string, DynamicSkillDelta>(),
    };
    existing.changes.set(skillName, {
        skillName,
        changeType,
        skillFilePath,
        ...(skillDescription ? { skillDescription } : {}),
    });
    dynamicSkillsDeltaState.set(agentId, existing);
}

function parseSkillDescriptionLine(line: string): string | undefined {
    const matched = line.match(/^\s*description\s*:\s*(.+?)\s*$/i);
    if (!matched) {
        return undefined;
    }
    const value = matched[1]?.trim();
    if (!value) {
        return undefined;
    }
    return value.replace(/^['"]|['"]$/g, "").trim() || undefined;
}

function readSkillDescription(skillFilePath: string): string | undefined {
    if (!fs.existsSync(skillFilePath)) {
        return undefined;
    }

    let content = "";
    try {
        content = fs.readFileSync(skillFilePath, "utf8");
    } catch {
        return undefined;
    }

    const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
    if (lines.length === 0) {
        return undefined;
    }

    if (lines[0]?.trim() === "---") {
        for (let i = 1; i < lines.length; i += 1) {
            const line = lines[i];
            if (line.trim() === "---" || line.trim() === "...") {
                break;
            }
            const description = parseSkillDescriptionLine(line);
            if (description) {
                return description;
            }
        }
        return undefined;
    }

    for (const line of lines) {
        const description = parseSkillDescriptionLine(line);
        if (description) {
            return description;
        }
    }
    return undefined;
}

function resolveSkillSignature(skillFilePath: string): string | undefined {
    try {
        const stat = fs.statSync(skillFilePath);
        return `${stat.mtimeMs}:${stat.size}`;
    } catch {
        return undefined;
    }
}

function collectDynamicSkillsSnapshot(skillsDir: string): Map<string, DynamicSkillSnapshot> {
    const snapshot = new Map<string, DynamicSkillSnapshot>();
    if (!fs.existsSync(skillsDir)) {
        return snapshot;
    }

    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
        return snapshot;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const skillName = entry.name;
        const skillDir = path.join(skillsDir, skillName);
        const skillFilePath = path.join(skillDir, "SKILL.md");
        if (!fs.existsSync(skillFilePath)) {
            continue;
        }

        const signature = resolveSkillSignature(skillFilePath);
        if (!signature) {
            continue;
        }

        snapshot.set(skillName, {
            skillName,
            skillDir,
            skillFilePath,
            signature,
        });
    }

    return snapshot;
}

function diffDynamicSkillsSnapshot(agentId: string, nextSnapshot: Map<string, DynamicSkillSnapshot>): void {
    const prevSnapshot = dynamicSkillsSnapshotState.get(agentId);
    if (!prevSnapshot) {
        // First sync after process start/workspace registration establishes baseline only.
        dynamicSkillsSnapshotState.set(agentId, nextSnapshot);
        return;
    }

    for (const [skillName, prev] of prevSnapshot) {
        const next = nextSnapshot.get(skillName);
        if (!next) {
            recordDynamicSkillDelta(agentId, skillName, "removed", prev.skillFilePath);
            continue;
        }
        if (next.signature !== prev.signature) {
            recordDynamicSkillDelta(
                agentId,
                skillName,
                "updated",
                next.skillFilePath,
            );
        }
    }

    for (const [skillName, next] of nextSnapshot) {
        if (prevSnapshot.has(skillName)) {
            continue;
        }
        recordDynamicSkillDelta(
            agentId,
            skillName,
            "added",
            next.skillFilePath,
            readSkillDescription(next.skillFilePath),
        );
    }

    dynamicSkillsSnapshotState.set(agentId, nextSnapshot);
}

function syncDynamicSkillsState(agentId: string, workspaceDir: string): void {
    const normalizedWorkspaceDir = path.resolve(workspaceDir);
    const existingWorkspaceDir = dynamicSkillsWorkspaceDirs.get(agentId);

    if (existingWorkspaceDir && existingWorkspaceDir !== normalizedWorkspaceDir) {
        dynamicSkillsSnapshotState.delete(agentId);
        dynamicSkillsDeltaState.delete(agentId);
    }

    dynamicSkillsWorkspaceDirs.set(agentId, normalizedWorkspaceDir);
    const skillsDir = path.join(normalizedWorkspaceDir, "skills");
    const nextSnapshot = collectDynamicSkillsSnapshot(skillsDir);
    diffDynamicSkillsSnapshot(agentId, nextSnapshot);
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
        const descriptionSuffix =
            change.changeType === "added" && change.skillDescription
                ? `; description: ${change.skillDescription}`
                : "";
        lines.push(`- ${change.changeType}: ${change.skillName} (${change.skillFilePath})${descriptionSuffix}`);
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
    reconcileDynamicSkillsState(agentId);

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

function reconcileDynamicSkillsState(agentId: string): void {
    const workspaceDir = dynamicSkillsWorkspaceDirs.get(agentId);
    if (!workspaceDir) {
        return;
    }

    syncDynamicSkillsState(agentId, workspaceDir);
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

    ensureDynamicAgentConfigured({
        dynamicAgentId,
        sourceAgentId,
        config: params.config,
        runtime: params.runtime,
        log: params.log,
    });

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

    syncDynamicSkillsState(dynamicAgentId, targetWorkspace);
}

export function prepareDynamicAgentRuntime(params: {
    dynamicAgentId: string;
    sourceAgentId: string;
    config: OpenClawConfig;
    runtime: PluginRuntime;
    log?: DynamicLogger;
    error?: DynamicLogger;
}): void {
    ensureDynamicAgentConfigured({
        dynamicAgentId: params.dynamicAgentId,
        sourceAgentId: params.sourceAgentId,
        config: params.config,
        runtime: params.runtime,
        log: params.log,
    });

    if (!getDynamicAgentConfig(params.config).workspaceSeed) {
        return;
    }

    ensureDynamicAgentWorkspace(params);
}

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PluginRegistry } from "./registry";
import { logger } from "../utils/logger";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * 运行时动态 node_modules 打补丁技术 (ESM 模块透明重定向)
 * 允许外部 OpenClaw 插件通过 import * as sdk from "@openclaw/plugin-sdk" 来调用 OAT 的注册表
 */
export async function patchPluginSdk() {
    const rootDir = process.cwd();
    const targetDir = path.join(rootDir, "node_modules", "@openclaw", "plugin-sdk");
    try {
        await fs.mkdir(targetDir, { recursive: true });
        // 写入虚拟的 package.json
        await fs.writeFile(path.join(targetDir, "package.json"), JSON.stringify({
            name: "@openclaw/plugin-sdk",
            version: "1.0.0",
            main: "./index.js",
            type: "module"
        }, null, 2), "utf8");
        // 动态定位 sdk-mock 文件
        const mockJsPath = path.resolve(__dirname, "sdk-mock.js");
        const existsJs = await fs.access(mockJsPath).then(() => true).catch(() => false);
        const finalMockPath = existsJs ? mockJsPath : path.resolve(__dirname, "sdk-mock.ts");
        // 使用 fileURLToPath 绝对路径防止 ESM 加载失败
        const fileUrl = pathToFileURL(finalMockPath).href;
        const mockContent = `
import * as mock from "${fileUrl}";
export const registerChannel = mock.registerChannel;
export const registerHook = mock.registerHook;
export default mock.default;
`;
        await fs.writeFile(path.join(targetDir, "index.js"), mockContent, "utf8");
    }
    catch (err) {
        logger.debug(`Dynamic SDK patch skipped: ${err.message}`);
    }
}
/**
 * 加载所有可用插件（包含内置 bundled 插件、全局和工作区本地插件）
 */
export async function loadPlugins() {
    // 1. 应用 node_modules 桥接补丁
    await patchPluginSdk();
    const searchDirs = [
        path.join(__dirname, "bundled"),
        path.join(os.homedir(), ".oat", "plugins"),
        path.join(process.cwd(), "plugins")
    ];
    const pluginPaths = new Set();
    async function scanDir(dir, depth = 0) {
        if (depth > 3)
            return;
        try {
            const exists = await fs.access(dir).then(() => true).catch(() => false);
            if (!exists)
                return;
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.name === "node_modules") {
                    await scanNodeModules(fullPath);
                    continue;
                }
                const manifestPath = path.join(fullPath, "openclaw.plugin.json");
                const hasManifest = await fs.access(manifestPath).then(() => true).catch(() => false);
                if (hasManifest) {
                    pluginPaths.add(fullPath);
                }
                else if (entry.name.startsWith("@")) {
                    await scanDir(fullPath, depth + 1);
                }
            }
        }
        catch (e) {
            logger.warn(`Failed reading plugin directory: ${dir}`, { error: e.message });
        }
    }
    async function scanNodeModules(nodeModulesPath) {
        try {
            const entries = await fs.readdir(nodeModulesPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const fullPath = path.join(nodeModulesPath, entry.name);
                if (entry.name.startsWith("@")) {
                    const subEntries = await fs.readdir(fullPath, { withFileTypes: true });
                    for (const subEntry of subEntries) {
                        if (!subEntry.isDirectory())
                            continue;
                        const subPath = path.join(fullPath, subEntry.name);
                        const hasManifest = await fs.access(path.join(subPath, "openclaw.plugin.json")).then(() => true).catch(() => false);
                        if (hasManifest) {
                            pluginPaths.add(subPath);
                        }
                    }
                }
                else {
                    const hasManifest = await fs.access(path.join(fullPath, "openclaw.plugin.json")).then(() => true).catch(() => false);
                    if (hasManifest) {
                        pluginPaths.add(fullPath);
                    }
                }
            }
        }
        catch (e) {
            logger.warn(`Failed scanning node_modules: ${nodeModulesPath}`, { error: e.message });
        }
    }
    for (const dir of searchDirs) {
        await scanDir(dir);
    }
    for (const pluginPath of pluginPaths) {
        await loadSinglePlugin(pluginPath);
    }
}
async function loadSinglePlugin(pluginPath) {
    const manifestPath = path.join(pluginPath, "openclaw.plugin.json");
    try {
        const rawManifest = await fs.readFile(manifestPath, "utf8");
        const manifest = JSON.parse(rawManifest);
        const entryPoint = manifest.entryPoint || "index.js";
        const entryPath = path.resolve(pluginPath, entryPoint);
        // 适配 Windows/mac 路径加载动态模块
        const fileUrl = pathToFileURL(entryPath).href;
        const module = await import(fileUrl);
        const pluginDef = module.default || module;
        if (typeof pluginDef.register === "function") {
            const api = {
                registerChannel: (plugin) => {
                    PluginRegistry.registerChannel(plugin);
                },
                registerHook: (name, callback) => {
                    PluginRegistry.registerHook(name, callback);
                }
            };
            pluginDef.register(api);
            // 注册 Manifest
            PluginRegistry.registerManifest(manifest.id, manifest);
            logger.info(`Successfully loaded compatible plugin: ${manifest.name || manifest.id}`);
        }
    }
    catch (e) {
        logger.warn(`Skipped invalid plugin at ${pluginPath}`, { error: e.message });
    }
}
/**
 * 零依赖高性能 JSON Schema 强类型校验器
 */
export function validateSchema(schema, data) {
    if (!schema)
        return { valid: true };
    const errors = [];
    function check(path, s, d) {
        if (!s)
            return;
        const type = s.type;
        if (type) {
            if (type === "string" && typeof d !== "string") {
                errors.push(`${path} must be a string`);
            }
            else if (type === "number" && typeof d !== "number") {
                errors.push(`${path} must be a number`);
            }
            else if (type === "boolean" && typeof d !== "boolean") {
                errors.push(`${path} must be a boolean`);
            }
            else if (type === "array" && !Array.isArray(d)) {
                errors.push(`${path} must be an array`);
            }
            else if (type === "object" && (typeof d !== "object" || d === null)) {
                errors.push(`${path} must be an object`);
            }
        }
        if (s.required && Array.isArray(s.required)) {
            for (const req of s.required) {
                if (d === undefined || d === null || d[req] === undefined) {
                    errors.push(`${path ? path + "." : ""}${req} is required`);
                }
            }
        }
        if (s.properties && typeof s.properties === "object" && typeof d === "object" && d !== null) {
            for (const [key, propSchema] of Object.entries(s.properties)) {
                if (d[key] !== undefined) {
                    check(path ? `${path}.${key}` : key, propSchema, d[key]);
                }
            }
        }
    }
    check("", schema, data);
    return { valid: errors.length === 0, errors };
}
/**
 * 动态基于配置 Schema 对账号配置参数进行强类型校验
 */
export async function validatePluginConfig(channelId, config) {
    const searchDirs = [
        path.join(__dirname, "bundled", channelId),
        path.join(os.homedir(), ".oat", "plugins", channelId),
        path.join(process.cwd(), "plugins", channelId),
        // 同时也适配 openclaw- 前缀目录
        path.join(__dirname, "bundled", `openclaw-${channelId}`),
        path.join(os.homedir(), ".oat", "plugins", `openclaw-${channelId}`),
        path.join(process.cwd(), "plugins", `openclaw-${channelId}`)
    ];
    for (const dir of searchDirs) {
        const manifestPath = path.join(dir, "openclaw.plugin.json");
        try {
            const raw = await fs.readFile(manifestPath, "utf8");
            const manifest = JSON.parse(raw);
            if (manifest.configSchema) {
                const { valid, errors } = validateSchema(manifest.configSchema, config);
                if (!valid) {
                    logger.error(`【全局配置格式错误 ❌】渠道 '${channelId}' 参数校验未通过:`);
                    errors?.forEach(err => logger.error(`  - ${err}`));
                    return false;
                }
            }
            return true;
        }
        catch {
            // 忽略找不到文件，继续探测下一个目录
        }
    }
    return true;
}

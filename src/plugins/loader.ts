import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PluginRegistry } from "./registry";
import { logger } from "../utils/logger";
import type { OpenClawPluginApi } from "./types";
import { t } from "../i18n/i18n";
import { ChannelPluginSourceEnum } from "../types/channels";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 运行时动态 node_modules 打补丁技术 (ESM 模块透明重定向)
 * 允许外部 OpenClaw 插件通过 import * as sdk from "@openclaw/plugin-sdk" 来调用 OAT 的注册表
 */
export async function patchPluginSdk(): Promise<void> {
  // Installed plugins resolve their peer SDK from this writable root. Keep it
  // first so a read-only packaged-app cwd cannot prevent the compatibility
  // bridge used by user-installed plugins from being created.
  const roots = [path.join(os.homedir(), ".oat", "plugins")];
  try {
    const legacyContent = `
const api = globalThis[Symbol.for("oat.openclaw.plugin-sdk")];
if (!api) throw new Error("OAT OpenClaw plugin SDK bridge is not initialized.");
export const registerChannel = (...args) => api.registerChannel(...args);
export const registerHook = (...args) => api.registerHook(...args);
export default api;
`;
    const modernContent = `
const api = globalThis[Symbol.for("oat.openclaw.plugin-sdk")];
if (!api) throw new Error("OAT OpenClaw plugin SDK bridge is not initialized.");
export const registerChannel = (...args) => api.registerChannel(...args);
export const registerHook = (...args) => api.registerHook(...args);
export const DEFAULT_ACCOUNT_ID = "default";
export const definePluginEntry = value => value;
export const defineChannelPluginEntry = value => value;
export const createChannelPlugin = value => value;
export const defineChannelSetupContract = value => value;
export const buildChannelConfigSchema = value => value;
export const buildJsonChannelConfigSchema = value => value;
export const createOptionalChannelSetupSurface = value => value;
export const createOptionalChannelSetupAdapter = value => value;
export const createOptionalChannelSetupWizard = value => value;
export const createTopLevelChannelDmPolicy = value => value;
export const moveSingleAccountChannelSectionToDefaultAccount = value => value;
export const defineBundledChannelSetupEntry = value => value;
export const createChannelEntry = value => value;
export const createChannelSetupAdapter = value => value;
export const createChannelSetupWizard = value => value;
export const defineChannelConfig = value => value;
export const defineChannelConfigSchema = value => value;
export const setSetupChannelEnabled = value => value;
export const splitSetupEntries = value => value;
export default api;
`;
    for (const rootDir of roots) {
      const legacyDir = path.join(rootDir, "node_modules", "@openclaw", "plugin-sdk");
      const legacyPackage = await fs.readFile(path.join(legacyDir, "package.json"), "utf8").then(JSON.parse).catch(() => undefined);
      if (!legacyPackage || legacyPackage.version === "0.0.0-oat-compat") {
        await fs.mkdir(legacyDir, { recursive: true });
        await fs.writeFile(path.join(legacyDir, "package.json"), JSON.stringify({ name: "@openclaw/plugin-sdk", version: "0.0.0-oat-compat", main: "./index.js", type: "module" }, null, 2), "utf8");
        await fs.writeFile(path.join(legacyDir, "index.js"), legacyContent, "utf8");
      }
      const modernDir = path.join(rootDir, "node_modules", "openclaw");
      const modernPackage = await fs.readFile(path.join(modernDir, "package.json"), "utf8").then(JSON.parse).catch(() => undefined);
      if (!modernPackage || modernPackage.version === "0.0.0-oat-compat") {
        await fs.mkdir(modernDir, { recursive: true });
        await fs.writeFile(path.join(modernDir, "package.json"), JSON.stringify({ name: "openclaw", version: "0.0.0-oat-compat", type: "module", exports: { "./plugin-sdk": "./sdk.js", "./plugin-sdk/*": "./sdk.js" } }, null, 2), "utf8");
        await fs.writeFile(path.join(modernDir, "sdk.js"), modernContent, "utf8");
      }
    }
  } catch (err: any) {
    logger.debug(`Dynamic SDK patch skipped: ${err.message}`);
  }
}

/**
 * 加载所有可用插件（包含内置 bundled 插件、全局和工作区本地插件）
 */
export async function loadPlugins(): Promise<void> {
  (globalThis as any)[Symbol.for("oat.openclaw.plugin-sdk")] = {
    registerChannel: (plugin: unknown) => PluginRegistry.registerChannel(plugin),
    registerHook: (name: string, callback: (...args: any[]) => void | Promise<void>) => PluginRegistry.registerHook(name, callback),
  };
  // 1. 应用 node_modules 桥接补丁
  await patchPluginSdk();

  const searchDirs = [
    ...(process.env.OAT_BUNDLED_PLUGIN_DIR ? [process.env.OAT_BUNDLED_PLUGIN_DIR] : []),
    path.join(__dirname, "bundled"),
    path.join(os.homedir(), ".oat", "plugins"),
    path.join(process.cwd(), "plugins")
  ];

  const pluginPaths = new Set<string>();

  async function scanDir(dir: string, depth = 0) {
    if (depth > 3) return;
    try {
      const exists = await fs.access(dir).then(() => true).catch(() => false);
      if (!exists) return;

      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(dir, entry.name);

        if (entry.name === "node_modules") {
          await scanNodeModules(fullPath);
          continue;
        }

        const manifestPath = path.join(fullPath, "openclaw.plugin.json");
        const hasManifest = await fs.access(manifestPath).then(() => true).catch(() => false);
        if (hasManifest) {
          pluginPaths.add(fullPath);
        } else if (entry.name.startsWith("@")) {
          await scanDir(fullPath, depth + 1);
        }
      }
    } catch (e: any) {
      logger.warn(`Failed reading plugin directory: ${dir}`, { error: e.message });
    }
  }

  async function scanNodeModules(nodeModulesPath: string) {
    try {
      const entries = await fs.readdir(nodeModulesPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(nodeModulesPath, entry.name);
        if (entry.name.startsWith("@")) {
          const subEntries = await fs.readdir(fullPath, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (!subEntry.isDirectory()) continue;
            const subPath = path.join(fullPath, subEntry.name);
            const hasManifest = await fs.access(path.join(subPath, "openclaw.plugin.json")).then(() => true).catch(() => false);
            if (hasManifest) {
              pluginPaths.add(subPath);
            }
          }
        } else {
          const hasManifest = await fs.access(path.join(fullPath, "openclaw.plugin.json")).then(() => true).catch(() => false);
          if (hasManifest) {
            pluginPaths.add(fullPath);
          }
        }
      }
    } catch (e: any) {
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

async function loadSinglePlugin(pluginPath: string): Promise<void> {
  const manifestPath = path.join(pluginPath, "openclaw.plugin.json");
  try {
    const rawManifest = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(rawManifest);
    const packageJson = await fs.readFile(path.join(pluginPath, "package.json"), "utf8").then(JSON.parse).catch(() => ({}));
    const openclaw = packageJson.openclaw && typeof packageJson.openclaw === "object" ? packageJson.openclaw : {};
    const extensions = Array.isArray(openclaw.runtimeExtensions) ? openclaw.runtimeExtensions : Array.isArray(openclaw.extensions) ? openclaw.extensions : [];
    const normalizedManifest = {
      ...manifest,
      name: manifest.name || packageJson.name || manifest.id,
      version: packageJson.version || manifest.version,
      description: manifest.description || packageJson.description,
      channels: Array.isArray(manifest.channels) ? manifest.channels.filter((value: unknown) => typeof value === "string") : [],
      channelConfigs: manifest.channelConfigs || {},
      oatSource: pluginPath.includes(`${path.sep}bundled${path.sep}`) ? ChannelPluginSourceEnum.Bundled : pluginPath.includes(`${path.sep}.oat${path.sep}plugins`) ? ChannelPluginSourceEnum.Installed : ChannelPluginSourceEnum.Workspace,
      bundled: pluginPath.includes(`${path.sep}bundled${path.sep}`),
      loaded: false,
    };
    PluginRegistry.registerManifest(manifest.id, normalizedManifest);

    const entryPoint = extensions[0] || manifest.entryPoint || packageJson.main || "index.js";
    const entryPath = path.resolve(pluginPath, entryPoint);

    // 适配 Windows/mac 路径加载动态模块
    const fileUrl = pathToFileURL(entryPath).href;
    const module = await import(fileUrl);
    const pluginDef = module.default || module;
    const register = typeof pluginDef === "function" ? pluginDef : typeof pluginDef.register === "function" ? pluginDef.register.bind(pluginDef) : undefined;

    if (register) {
      const api: OpenClawPluginApi = {
        registerChannel: (plugin) => {
          PluginRegistry.registerChannel(plugin);
        },
        registerHook: (name, callback) => {
          PluginRegistry.registerHook(name, callback);
        },
        on: (name, callback) => PluginRegistry.registerHook(name, callback),
        registerService: (service) => PluginRegistry.registerService(service),
        runtime: { channel: { inbound: { dispatch: (message) => PluginRegistry.dispatchInbound(message) } } },
        logger: {
          debug: (message, data) => logger.debug(message, data as Record<string, unknown> | undefined),
          info: (message, data) => logger.info(message, data as Record<string, unknown> | undefined),
          warn: (message, data) => logger.warn(message, data as Record<string, unknown> | undefined),
          error: (message, data) => logger.error(message, data as Record<string, unknown> | undefined),
        },
      };
      await register(api);
      PluginRegistry.registerManifest(manifest.id, { ...normalizedManifest, loaded: true });
      
      logger.info(`Successfully loaded compatible plugin: ${manifest.name || manifest.id}`);
    }
  } catch (e: any) {
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      PluginRegistry.registerManifest(manifest.id, { ...manifest, loaded: false, error: e.message });
    } catch { /* invalid manifest has no stable id */ }
    logger.warn(`Skipped invalid plugin at ${pluginPath}`, { error: e.message });
  }
}

/**
 * 零依赖高性能 JSON Schema 强类型校验器
 */
export function validateSchema(schema: any, data: any): { valid: boolean; errors?: string[] } {
  if (!schema) return { valid: true };
  const errors: string[] = [];

  function check(path: string, s: any, d: any) {
    if (!s) return;
    if (Array.isArray(s.allOf)) for (const child of s.allOf) check(path, child, d);
    if (Array.isArray(s.anyOf) && !s.anyOf.some((child: unknown) => validateSchema(child, d).valid)) errors.push(`${path || "value"} must match at least one allowed schema`);
    if (Array.isArray(s.oneOf) && s.oneOf.filter((child: unknown) => validateSchema(child, d).valid).length !== 1) errors.push(`${path || "value"} must match exactly one allowed schema`);
    if (Object.hasOwn(s, "const") && !Object.is(s.const, d)) errors.push(`${path || "value"} must equal the declared constant`);
    const type = s.type;
    
    if (type) {
      if (type === "string" && typeof d !== "string") {
        errors.push(`${path} must be a string`);
      } else if ((type === "number" || type === "integer") && (typeof d !== "number" || (type === "integer" && !Number.isInteger(d)))) {
        errors.push(`${path} must be a number`);
      } else if (type === "boolean" && typeof d !== "boolean") {
        errors.push(`${path} must be a boolean`);
      } else if (type === "array" && !Array.isArray(d)) {
        errors.push(`${path} must be an array`);
      } else if (type === "object" && (typeof d !== "object" || d === null)) {
        errors.push(`${path} must be an object`);
      }
    }

    if (Array.isArray(s.enum) && !s.enum.some((value: unknown) => Object.is(value, d))) errors.push(`${path} must be one of the declared values`);
    if (typeof d === "string") {
      if (typeof s.minLength === "number" && d.length < s.minLength) errors.push(`${path} is too short`);
      if (typeof s.maxLength === "number" && d.length > s.maxLength) errors.push(`${path} is too long`);
      if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(d)) errors.push(`${path} has an invalid format`);
    }
    if (typeof d === "number") {
      if (typeof s.minimum === "number" && d < s.minimum) errors.push(`${path} is below the minimum`);
      if (typeof s.maximum === "number" && d > s.maximum) errors.push(`${path} exceeds the maximum`);
    }
    if (Array.isArray(d) && s.items) d.forEach((item, index) => check(`${path}[${index}]`, s.items, item));

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
      if (s.additionalProperties === false) for (const key of Object.keys(d)) if (!(key in s.properties)) errors.push(`${path ? `${path}.` : ""}${key} is not allowed`);
    }
  }

  check("", schema, data);
  return { valid: errors.length === 0, errors };
}

/**
 * 动态基于配置 Schema 对账号配置参数进行强类型校验
 */
export async function validatePluginConfig(channelId: string, config: Record<string, any>): Promise<boolean> {
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
          logger.error(t("channel_validation_failed", { channelId }));
          errors?.forEach(err => logger.error(`  - ${err}`));
          return false;
        }
      }
      return true;
    } catch {
      // 忽略找不到文件，继续探测下一个目录
    }
  }
  return true;
}

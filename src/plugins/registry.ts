import type { ChannelPlugin, GatewayHookCallback } from "./types";
import { logger } from "../utils/logger";

export class PluginRegistry {
  private static channels = new Map<string, ChannelPlugin>();
  private static hooks = new Map<string, GatewayHookCallback[]>();
  private static manifests = new Map<string, any>();

  public static registerChannel(plugin: any): void {
    const actualPlugin = plugin && plugin.plugin ? plugin.plugin : plugin;
    this.channels.set(actualPlugin.id, actualPlugin);
  }

  public static getChannel(id: string): ChannelPlugin | undefined {
    return this.channels.get(id);
  }

  public static getRegisteredChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  public static registerManifest(id: string, manifest: any): void {
    this.manifests.set(id, manifest);
  }

  public static getManifest(id: string): any | undefined {
    return this.manifests.get(id);
  }

  public static getAllManifests(): any[] {
    return Array.from(this.manifests.values());
  }

  public static unregisterPlugin(id: string): void {
    this.channels.delete(id);
    this.manifests.delete(id);
  }

  public static registerHook(name: string, callback: GatewayHookCallback): void {
    if (!this.hooks.has(name)) {
      this.hooks.set(name, []);
    }
    this.hooks.get(name)!.push(callback);
  }

  public static async triggerHook(name: string, ...args: any[]): Promise<void> {
    const list = this.hooks.get(name) || [];
    for (const callback of list) {
      try {
        await Promise.resolve(callback(...args));
      } catch (err: any) {
        logger.error(`Error in hook '${name}':`, { error: err.message });
      }
    }
  }
}

import type { ChannelPlugin, GatewayHookCallback, InboundChannelMessage } from "./types";
import { logger } from "../utils/logger";

export class PluginRegistry {
  private static channels = new Map<string, ChannelPlugin>();
  private static hooks = new Map<string, GatewayHookCallback[]>();
  private static manifests = new Map<string, any>();
  private static services = new Map<string, { stop?: () => void | Promise<void> }>();
  private static inboundHandler?: (message: InboundChannelMessage) => Promise<unknown>;

  public static registerChannel(plugin: any): void {
    const actualPlugin = plugin && plugin.plugin ? plugin.plugin : plugin;
    this.channels.set(actualPlugin.id, actualPlugin);
    if (actualPlugin.id.startsWith("openclaw-")) this.channels.set(actualPlugin.id.replace(/^openclaw-/, ""), actualPlugin);
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

  public static registerService(service: { id?: string; start?: () => void | Promise<void>; stop?: () => void | Promise<void> }): void {
    const id = service.id || `service-${this.services.size + 1}`;
    this.services.set(id, service);
    void service.start?.();
  }

  public static setInboundHandler(handler: (message: InboundChannelMessage) => Promise<unknown>): void {
    this.inboundHandler = handler;
  }

  public static async dispatchInbound(message: InboundChannelMessage): Promise<unknown> {
    if (!this.inboundHandler) throw new Error("No OAT channel inbound handler is registered.");
    return this.inboundHandler(message);
  }

  public static getManifest(id: string): any | undefined {
    return this.manifests.get(id);
  }

  public static getAllManifests(): any[] {
    return Array.from(this.manifests.values());
  }

  public static unregisterPlugin(id: string): void {
    this.channels.delete(id);
    this.channels.delete(id.replace(/^openclaw-/, ""));
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

  public static async shutdown(): Promise<void> {
    await this.triggerHook("gateway_stop");
    for (const service of this.services.values()) await service.stop?.();
    this.services.clear();
  }
}

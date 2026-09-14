import { PluginRegistry } from "./registry";
import type { ChannelPlugin, GatewayHookCallback } from "./types";

export const registerChannel = (plugin: any): void => {
  PluginRegistry.registerChannel(plugin);
};

export const registerHook = (name: string, callback: GatewayHookCallback): void => {
  PluginRegistry.registerHook(name, callback);
};

export const on = registerHook;

export const registerService = (service: { id?: string; start?: () => void | Promise<void>; stop?: () => void | Promise<void> }): void => {
  PluginRegistry.registerService(service);
};

export default {
  registerChannel,
  registerHook,
  on,
  registerService,
};

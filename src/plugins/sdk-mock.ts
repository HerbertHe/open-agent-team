import { PluginRegistry } from "./registry";
import type { ChannelPlugin, GatewayHookCallback } from "./types";

export const registerChannel = (plugin: any): void => {
  PluginRegistry.registerChannel(plugin);
};

export const registerHook = (name: string, callback: GatewayHookCallback): void => {
  PluginRegistry.registerHook(name, callback);
};

export default {
  registerChannel,
  registerHook
};

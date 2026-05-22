export interface OutboundContext {
  config: Record<string, any>;
  text: string;
  metadata?: Record<string, any>;
  media?: {
    type: "image" | "file";
    path: string;
    filename?: string;
  };
}

export interface ChannelOutboundAdapter {
  deliveryMode: "direct" | "queued";
  sendText: (context: OutboundContext) => Promise<{ ok: boolean; messageId?: string }>;
  sendImage?: (context: OutboundContext) => Promise<{ ok: boolean; messageId?: string }>;
  sendFile?: (context: OutboundContext) => Promise<{ ok: boolean; messageId?: string }>;
}

export interface ChannelPlugin {
  id: string;
  meta: {
    name: string;
    version: string;
    description?: string;
  };
  outbound: ChannelOutboundAdapter;
  login?: (params: { config: Record<string, any>; sessionCachePath: string }) => Promise<void>;
}

export type GatewayHookCallback = (...args: any[]) => void | Promise<void>;

export interface OpenClawPluginApi {
  registerChannel: (plugin: ChannelPlugin) => void;
  registerHook: (name: "gateway_stop" | string, callback: GatewayHookCallback) => void;
}

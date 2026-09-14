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
  status?: (params: { config: Record<string, any>; accountId: string }) => Promise<{ connected: boolean; error?: string }>;
}

export interface InboundChannelMessage {
  channelId: string;
  accountId: string;
  text: string;
  messageId?: string;
  conversationId?: string;
  senderId?: string;
  metadata?: Record<string, unknown>;
}

export type GatewayHookCallback = (...args: any[]) => void | Promise<void>;

export interface OpenClawPluginApi {
  registerChannel: (plugin: ChannelPlugin) => void;
  registerHook: (name: "gateway_stop" | string, callback: GatewayHookCallback) => void;
  on: (name: string, callback: GatewayHookCallback) => void;
  registerService: (service: { id?: string; start?: () => void | Promise<void>; stop?: () => void | Promise<void> }) => void;
  runtime: {
    channel: {
      inbound: { dispatch: (message: InboundChannelMessage) => Promise<unknown> };
    };
  };
  logger: { debug(message: string, data?: unknown): void; info(message: string, data?: unknown): void; warn(message: string, data?: unknown): void; error(message: string, data?: unknown): void };
}

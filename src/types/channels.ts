export enum ChannelPluginSourceEnum {
  Bundled = "bundled",
  Installed = "installed",
  Workspace = "workspace",
}

export enum ChannelConnectionStatusEnum {
  NotConfigured = "not_configured",
  Configured = "configured",
  Connected = "connected",
  Degraded = "degraded",
  Error = "error",
}

export enum ChannelBindingTargetEnum {
  ResourceSupervisor = "resource_supervisor",
  ProjectAdmin = "project_admin",
  TeamAdmin = "team_admin",
}

export enum ChannelDeliveryStatusEnum {
  Replied = "replied",
  Queued = "queued",
}

export enum ChannelInboxStatusEnum {
  Processing = "processing",
  PendingProject = "pending_project",
  Queued = "queued",
  Delivered = "delivered",
  Failed = "failed",
}

export interface ChannelProjectBinding {
  id: string;
  channelId: string;
  accountId: string;
  target: ChannelBindingTargetEnum;
  projectName?: string;
  targetAgentId?: string;
  enabled: boolean;
}

export interface ChannelSchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  writeOnly?: boolean;
  properties?: Record<string, ChannelSchemaProperty>;
  items?: ChannelSchemaProperty;
}

export interface ChannelConfigSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, ChannelSchemaProperty>;
}

export interface ChannelConfigDescriptor {
  schema?: ChannelConfigSchema;
  uiHints?: Record<string, { label?: string; placeholder?: string; help?: string; sensitive?: boolean }>;
  label?: string;
  description?: string;
  preferOver?: string[];
}

export interface ChannelPluginDescriptor {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  source: ChannelPluginSourceEnum;
  bundled: boolean;
  loaded: boolean;
  error?: string;
  channels: string[];
  channelConfigs: Record<string, ChannelConfigDescriptor>;
  accounts: string[];
}

export interface ChannelAccountStatus {
  channelId: string;
  accountId: string;
  status: ChannelConnectionStatusEnum;
  error?: string;
}

export interface ChannelAgentTarget {
  target: ChannelBindingTargetEnum.ProjectAdmin | ChannelBindingTargetEnum.TeamAdmin;
  projectName: string;
  agentId: string;
  label: string;
  projectLabel: string;
  online: boolean;
}

export interface ChannelInboundMessage {
  channelId: string;
  accountId: string;
  text: string;
  messageId?: string;
  conversationId?: string;
  senderId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelDeliveryResult {
  status: ChannelDeliveryStatusEnum;
  target: ChannelBindingTargetEnum;
  projectName?: string;
  targetAgentId?: string;
  taskId?: string;
  reply?: string;
}

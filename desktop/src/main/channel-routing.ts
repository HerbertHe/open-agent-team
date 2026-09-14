import {
  ChannelBindingTargetEnum,
  type ChannelInboundMessage,
  type ChannelProjectBinding,
} from '../shared/channel-types.js';

export function activeChannelBinding(
  bindings: ChannelProjectBinding[],
  message: Pick<ChannelInboundMessage, 'channelId' | 'accountId'>,
): ChannelProjectBinding {
  const assigned = bindings.find((binding) => binding.enabled
    && binding.channelId === message.channelId
    && binding.accountId === message.accountId);
  if (assigned) return assigned;
  return {
    id: `default:${message.channelId}:${message.accountId}`,
    channelId: message.channelId,
    accountId: message.accountId,
    target: ChannelBindingTargetEnum.ResourceSupervisor,
    enabled: true,
  };
}

export function validateChannelBindings(value: unknown): ChannelProjectBinding[] {
  if (!Array.isArray(value)) throw new Error('channelBindings must be an array.');
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`channelBindings[${index}] must be an object.`);
    const binding = item as Partial<ChannelProjectBinding>;
    if (!binding.id || typeof binding.id !== 'string' || ids.has(binding.id)) throw new Error(`channelBindings[${index}].id must be unique.`);
    ids.add(binding.id);
    if (!binding.channelId || typeof binding.channelId !== 'string') throw new Error(`channelBindings[${index}].channelId is required.`);
    if (!binding.accountId || typeof binding.accountId !== 'string') throw new Error(`channelBindings[${index}].accountId is required.`);
    if (!Object.values(ChannelBindingTargetEnum).includes(binding.target as ChannelBindingTargetEnum)) throw new Error(`channelBindings[${index}].target is invalid.`);
    if ([ChannelBindingTargetEnum.ProjectAdmin, ChannelBindingTargetEnum.TeamAdmin].includes(binding.target as ChannelBindingTargetEnum) && (!binding.projectName || !binding.targetAgentId)) {
      throw new Error(`channelBindings[${index}] requires projectName and targetAgentId.`);
    }
    return {
      id: binding.id,
      channelId: binding.channelId,
      accountId: binding.accountId,
      target: binding.target as ChannelBindingTargetEnum,
      projectName: binding.target !== ChannelBindingTargetEnum.ResourceSupervisor ? binding.projectName : undefined,
      targetAgentId: binding.target !== ChannelBindingTargetEnum.ResourceSupervisor ? binding.targetAgentId : undefined,
      enabled: binding.enabled !== false,
    };
  });
}

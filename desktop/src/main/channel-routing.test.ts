import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelBindingTargetEnum } from '../shared/channel-types.js';
import { activeChannelBinding, validateChannelBindings } from './channel-routing.js';

test('unassigned accounts route to the resource supervisor', () => {
  const binding = activeChannelBinding([], { channelId: 'telegram', accountId: 'default' });
  assert.equal(binding.target, ChannelBindingTargetEnum.ResourceSupervisor);
});

test('an explicit account binding routes to a project admin', () => {
  const bindings = validateChannelBindings([{
    id: 'binding-1', channelId: 'slack', accountId: 'support',
    target: ChannelBindingTargetEnum.ProjectAdmin, projectName: 'alpha', targetAgentId: 'admin', enabled: true,
  }]);
  assert.equal(activeChannelBinding(bindings, { channelId: 'slack', accountId: 'support' }).projectName, 'alpha');
});

test('an explicit account binding routes to a team management agent', () => {
  const bindings = validateChannelBindings([{
    id: 'binding-2', channelId: 'telegram', accountId: 'engineering',
    target: ChannelBindingTargetEnum.TeamAdmin, projectName: 'alpha', targetAgentId: 'engineering-lead', enabled: true,
  }]);
  const binding = activeChannelBinding(bindings, { channelId: 'telegram', accountId: 'engineering' });
  assert.equal(binding.target, ChannelBindingTargetEnum.TeamAdmin);
  assert.equal(binding.targetAgentId, 'engineering-lead');
});

test('project bindings require an admin target', () => {
  assert.throws(() => validateChannelBindings([{
    id: 'binding-1', channelId: 'slack', accountId: 'support', target: ChannelBindingTargetEnum.ProjectAdmin,
  }]));
});

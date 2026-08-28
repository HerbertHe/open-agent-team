import assert from 'node:assert/strict';
import test from 'node:test';
import { RESOURCE_MANAGER_TOOL_NAMES, ResourceManagerToolNameEnum } from './resource-supervisor.js';

test('Resource Manager exposes read and proposal tools only', () => {
  assert.deepEqual(RESOURCE_MANAGER_TOOL_NAMES, [
    ResourceManagerToolNameEnum.ListProjectResources,
    ResourceManagerToolNameEnum.DraftProjectConfiguration,
  ]);
  for (const forbidden of ['start_project', 'restart_project', 'start_docker', 'restart_docker', 'restart_agent', 'bash']) {
    assert.equal(RESOURCE_MANAGER_TOOL_NAMES.includes(forbidden as ResourceManagerToolNameEnum), false);
  }
});

import { resourceToolDefinitions } from './resource-schemas.js';
import { executeResourceOperation, ResourceServiceError } from './resource-service.js';

export const RESOURCE_MCP_TOOL_NAMES = Object.freeze([
  'hearth_resource_read', 'hearth_resource_create', 'hearth_resource_update',
]);

export const RESOURCE_MCP_TOOLS = Object.freeze(resourceToolDefinitions());

export function isResourceMcpTool(name) {
  return RESOURCE_MCP_TOOL_NAMES.includes(name);
}

export function resourceMcpScope(name) {
  return name === 'hearth_resource_read' ? 'hearth:read' : 'hearth:write';
}

export async function runResourceMcpTool(name, args, env, config) {
  try {
    return { data: await executeResourceOperation(name, args, env, config), status: 200 };
  } catch (error) {
    if (error instanceof ResourceServiceError) return { data: { error: error.message }, status: error.status };
    return { data: { error: 'Resource operation failed' }, status: 500 };
  }
}

import { buildToolDefs } from '@agentigram/mcp';
import { MCP_TOOL_NAMES } from '@agentigram/protocol';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { requestIpc } from './ipc.js';

const MCP_REQUEST_TIMEOUT_MS = 2_000;

export async function runMcpServer(socketPath: string, sessionId: string): Promise<void> {
  const server = new Server(
    { name: 'agentigram', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildToolDefs() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (!MCP_TOOL_NAMES.includes(request.params.name as (typeof MCP_TOOL_NAMES)[number])) {
        return { isError: true, content: [{ type: 'text' as const, text: 'Unknown tool' }] };
      }
      const response = await requestIpc(
        socketPath,
        {
          type: 'tool',
          name: request.params.name as (typeof MCP_TOOL_NAMES)[number],
          args: request.params.arguments ?? {},
          sessionId,
        },
        MCP_REQUEST_TIMEOUT_MS,
      );
      if (!response.ok)
        return { isError: true, content: [{ type: 'text' as const, text: response.error }] };
      return { content: [{ type: 'text' as const, text: JSON.stringify(response.output) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  });
  await server.connect(new StdioServerTransport());
}

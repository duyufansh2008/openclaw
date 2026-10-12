import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createOpenClawCodingToolsAsync } from '/home/proof/stable-prefix/lib/node_modules/openclaw/dist/plugin-sdk/agent-harness.js';
import { createAgentHarnessToolSurfaceRuntime } from '/home/proof/stable-prefix/lib/node_modules/openclaw/dist/plugin-sdk/agent-harness-tool-runtime.js';

// Real shipped SDK, registered plugin, real model transport. No mocked API or results.
const config = JSON.parse(await fs.readFile('/home/proof/.openclaw/openclaw.json', 'utf8'));
const sessionKey = 'agent:main:pr148193-structured-sdk-proof';
const dispatched = [];
const surface = createAgentHarnessToolSurfaceRuntime({
  config, agentId: 'main', sessionKey, modelToolsEnabled: true,
  modelProvider: 'proof-sdk', modelId: 'headless',
  executeTool: async (p) => {
    dispatched.push({ name: p.toolName, input: p.input });
    const r = await p.tool.execute(p.toolCallId, p.input, p.signal, p.onUpdate);
    return p.acceptResultBeforeProjection(r);
  },
});
try {
  assert.equal(surface.toolSearchControlsEnabled, true);
  const assembled = await createOpenClawCodingToolsAsync({
    config, agentId: 'main', sessionKey,
    workspaceDir: '/home/proof/workspace', agentDir: '/home/proof/.openclaw/agents/main/agent',
    includeCoreTools: false,
    toolSearchCatalogRef: surface.toolSearchCatalogRef,
    toolSearchCatalogExecutor: surface.toolSearchCatalogExecutor,
    includeToolSearchControls: surface.includeToolSearchControls,
  });
  const { tools } = surface.compactTools(assembled);
  const search = tools.find(t => t.name === 'tool_search');
  const call = tools.find(t => t.name === 'tool_call');
  assert.ok(search && call, 'structured controls must be present');
  const discovered = await search.execute('proof-search', { query: 'local_image', limit: 1 });
  console.log(JSON.stringify({ stage: 'discovery', visibleTools: tools.map(t => t.name), discovered }));
  const candidates = discovered.details;
  const id = candidates?.find(c => c.name === 'local_image')?.id;
  assert.ok(id, 'local_image must be discovered by the real catalog');
  const result = await call.execute('proof-call', { id, args: { path: 'ocr.png', task: 'ocr' } });
  console.log(JSON.stringify({ stage: 'returned', dispatched, result }));
  assert.equal(result.details?.result?.details?.text, 'OPENCLAW OCR 4827');
  assert.equal(dispatched.at(-1)?.name, 'local_image');
  console.log(JSON.stringify({ stage: 'inference', passed: true, dispatched, result }));
} finally {
  surface.cleanup();
}

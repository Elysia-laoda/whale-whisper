#!/usr/bin/env node
/**
 * test-server.mjs
 * 用官方 SDK 客户端连接 server.js（stdio），验证：
 *   1. 工具列表包含 open_supplement_widget，且带 _meta.ui.resourceUri
 *   2. 资源列表包含 ui://supplement-widget/panel（text/html;profile=mcp-app）
 *   3. 读取资源返回的 HTML 大小合理、含内联 bundle 与挂件逻辑
 *   4. 调用工具返回 content / structuredContent / _meta.ui
 */
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const serverPath = path.join(here, '.', 'server.js');

const client = new Client({ name: 'supplement-widget-test', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  stderr: 'inherit',
});

await client.connect(transport);
console.log('[test] connected to server');

// 1. tools
const { tools } = await client.listTools();
const tool = tools.find((t) => t.name === 'open_supplement_widget');
assert(tool, 'open_supplement_widget 工具缺失');
assert.equal(tool._meta?.ui?.resourceUri, 'ui://supplement-widget/panel', 'tool _meta.ui.resourceUri 不正确');
assert(tool.inputSchema?.properties?.float, 'inputSchema 缺少 float 参数');
console.log('[test] ✓ tool ok: _meta.ui.resourceUri =', tool._meta.ui.resourceUri);

// 2. resources
const { resources } = await client.listResources();
const res = resources.find((r) => r.uri === 'ui://supplement-widget/panel');
assert(res, 'UI 资源缺失');
assert.equal(res.mimeType, 'text/html;profile=mcp-app', '资源 MIME 不正确');
console.log('[test] ✓ resource ok:', res.uri, res.mimeType);

// 3. read resource
const read = await client.readResource({ uri: 'ui://supplement-widget/panel' });
const html = read.contents?.[0]?.text || '';
assert(html.length > 200_000, 'HTML 太小，可能未内联 bundle（' + html.length + ' bytes）');
assert(html.includes('__SUPP_EXT__'), 'HTML 缺少内联的 ext-apps bundle');
assert(html.includes('open_supplement_widget') || html.includes('AskUserQuestion'), 'HTML 缺少挂件逻辑');
console.log('[test] ✓ html ok:', (html.length / 1024).toFixed(1), 'KB, mime =', read.contents[0].mimeType);

// 4. call tool
const call = await client.callTool({ name: 'open_supplement_widget', arguments: { float: true } });
assert(call.content?.[0]?.type === 'text', '工具返回缺少文本');
assert(call.structuredContent?.opened === true, 'structuredContent.opened 应为 true');
assert.equal(call._meta?.ui?.resourceUri, 'ui://supplement-widget/panel', '工具返回的 _meta.ui 不正确');
console.log('[test] ✓ callTool ok: float =', call.structuredContent.float);

// float:false
const call2 = await client.callTool({ name: 'open_supplement_widget', arguments: { float: false } });
assert(call2.structuredContent?.float === false, 'float=false 未生效');
console.log('[test] ✓ callTool(float:false) ok');

await client.close();
console.log('[test] ALL PASSED ✓');

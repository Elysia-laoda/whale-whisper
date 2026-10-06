#!/usr/bin/env node
/**
 * 补充提示挂件 · MCP App 服务器（stdio）
 *
 * 提供：
 *   - 工具 open_supplement_widget：打开对话内挂件（声明 _meta.ui.resourceUri）
 *   - 资源 ui://supplement-widget/panel：挂件的 HTML（text/html;profile=mcp-app）
 *
 * 工作方式：
 *   模型调用 open_supplement_widget 后，WorkBuddy/CodeBuddy 会在对话里
 *   渲染挂件；用户点击挂件时，挂件页面通过 ext-apps 的
 *   updateModelContext / sendMessage 向正在运行的 AI 注入一条"立即提问"指令，
 *   AI 随即调用 AskUserQuestion（提问功能）问用户"有什么要补充的吗？"
 *
 * 注意：stdio 服务器只能向 stdout 写协议报文，所有日志走 stderr。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

const SERVER_NAME = 'supplement-widget';
const SERVER_VERSION = '1.0.0';
const TOOL_NAME = 'open_supplement_widget';
const UI_URI = 'ui://supplement-widget/panel';
const UI_MIME = 'text/html;profile=mcp-app';

const WIDGET_PATH = path.join(here, 'widget', 'widget.html');

function loadWidgetHtml() {
  return readFileSync(WIDGET_PATH, 'utf8');
}

const TOOL_DESCRIPTION = [
  '打开「补充提示挂件」——一个常驻在对话里的交互小挂件。',
  '用户点击它，就能在不打断当前任务的情况下随时补充提示词：挂件会立刻通知你（通过系统提醒或对话消息），',
  '届时你必须立即调用 AskUserQuestion 工具，向用户提问「有什么要补充的吗？」。',
  '',
  '何时使用：',
  '1) 用户说「打开挂件 / 把挂件挂着 / 我要随时补充」等；',
  '2) 你即将开始一个预计较长时间、多步骤的任务，先打开挂件（悬浮），方便用户中途补充——除非用户表示不需要；',
  '3) 同一会话里挂件已打开过、仍可见时，不必重复打开。',
  '',
  '参数 float：是否请求悬浮(pip)显示，默认 true（悬浮后挂件固定在窗口角落，方便随时点击）。',
  '',
  'Open the Supplement Widget — an interactive MCP App pendant. When the user clicks it,',
  'you will immediately receive a supplement request and must call AskUserQuestion',
  '("有什么要补充的吗？"). Use it when the user wants to add mid-task instructions without interrupting the run.',
].join('\n');

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {}, resources: {} } },
);

/* ---------------- 工具 ---------------- */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAME,
      title: '打开补充提示挂件',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          float: {
            type: 'boolean',
            description: '是否请求悬浮(picture-in-picture)显示，默认 true。悬浮后挂件固定在窗口角落，方便任务运行中随手点击。',
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: '打开补充提示挂件',
        readOnlyHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: UI_URI } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (name !== TOOL_NAME) {
    return {
      content: [{ type: 'text', text: '未知工具：' + name }],
      isError: true,
    };
  }

  const args = req.params.arguments || {};
  const float = args.float !== false;

  const text = [
    '补充提示挂件已在本条消息中打开' + (float ? '，并已请求悬浮显示。' : '。'),
    '使用方式：用户点击挂件中央的鲸鱼按钮后，你会在最近的模型调用中收到一条「补充提示挂件事件」',
    '（可能是系统提醒，也可能是一条用户消息，两者携带同一个事件 ID）。',
    '收到事件后：立即调用 AskUserQuestion 工具向用户提问「有什么要补充的吗？」；',
    '等用户回答后，把他的补充内容纳入当前计划再继续执行；同一事件 ID 只需提问一次。',
  ].join('');

  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      opened: true,
      float,
      openedAt: new Date().toISOString(),
    },
    _meta: { ui: { resourceUri: UI_URI } },
  };
});

/* ---------------- 资源（挂件 HTML） ---------------- */

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: UI_URI,
      name: 'supplement-widget-panel',
      title: '补充提示挂件',
      description: '点击即可通知正在运行的 AI 立即询问「有什么要补充的吗？」的对话内挂件。',
      mimeType: UI_MIME,
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== UI_URI) {
    throw new Error('未知资源：' + req.params.uri);
  }
  const html = loadWidgetHtml();
  return {
    contents: [
      {
        uri: UI_URI,
        mimeType: UI_MIME,
        text: html,
        _meta: {
          ui: {
            csp: {
              // 完全离线：不需要任何外部域名
              resourceDomains: [],
              connectDomains: [],
            },
            permissions: {},
            prefersBorder: true,
          },
        },
      },
    ],
  };
});

/* ---------------- 启动 ---------------- */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[supplement-widget] MCP server ready (stdio). widget=' + WIDGET_PATH);

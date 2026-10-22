#!/usr/bin/env node
/**
 * 只读冒烟测试：用自动发现定位本机 Agent，列出三个 provider 的模型与免费状态。
 *
 *   node tests/live-smoke.mjs            # 只列目录，不联网、不消耗积分
 *   node tests/live-smoke.mjs --live     # 用免费模型各发一次带工具调用的请求
 *
 * 不读取、不打印任何凭据；--live 只选择免费模型。
 */
import { discoveryReport } from '../lib/discovery.js';
import { createWorkBuddyConnector } from '../lib/workbuddy-connector.js';
import { createHermesConnector } from '../lib/hermes-connector.js';
import { AgentLlmAdapter } from '../lib/adapter.js';

const LIVE = process.argv.includes('--live');
const report = await discoveryReport();

const connectors = [];
if (report.workbuddyAiHome) {
  connectors.push(
    createWorkBuddyConnector({
      provider: 'workbuddy-ai',
      displayName: 'WorkBuddy AI',
      sourceLabel: 'WorkBuddy AI',
      dataRoot: report.workbuddyAiHome,
    }),
  );
}
if (report.workbuddyHome) {
  connectors.push(
    createWorkBuddyConnector({
      provider: 'workbuddy',
      displayName: 'WorkBuddy',
      sourceLabel: 'WorkBuddy',
      dataRoot: report.workbuddyHome,
    }),
  );
}
for (const home of report.hermesHomes.slice(0, 1)) {
  connectors.push(
    createHermesConnector({ provider: 'hermes-agent', displayName: 'Hermes Agent', home }),
  );
}

if (connectors.length === 0) {
  console.log('未发现已登录的 Agent。请先安装并登录 WorkBuddy AI / WorkBuddy / Hermes Agent。');
  process.exit(0);
}

const adapter = new AgentLlmAdapter(connectors);

const messages = [
  { role: 'system', content: [{ type: 'text', text: 'You are a concise assistant.' }], source: { kind: 'system-prompt' }, id: 'sys' },
  {
    role: 'user',
    content: [{ type: 'text', text: 'Call the add tool to add 2 and 3, then reply with the result.' }],
    source: { kind: 'user' },
    id: 'u1',
  },
];
const tools = [
  {
    name: 'add',
    description: 'Add two integers',
    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
];

async function summarize(provider, model) {
  const chunks = [];
  const started = Date.now();
  for await (const chunk of adapter.stream({
    provider,
    model,
    messages,
    tools,
    maxTokens: 256,
    signal: AbortSignal.timeout(120000),
  })) {
    chunks.push(chunk);
  }
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  const toolCalls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').map((c) => c.block);
  const usage = chunks.find((c) => c.type === 'usage')?.usage;
  const finish = chunks.find((c) => c.type === 'finish')?.reason;
  console.log(`  [${provider}/${model}] ${Date.now() - started}ms finish=${JSON.stringify(finish)}`);
  if (text) console.log(`    text=${JSON.stringify(text.slice(0, 160))}`);
  if (toolCalls.length) console.log(`    tool_calls=${JSON.stringify(toolCalls).slice(0, 400)}`);
  console.log(`    usage=${JSON.stringify(usage)}`);
}

for (const connector of connectors) {
  try {
    const models = await adapter.listModels(connector.provider);
    const free = models.filter((m) => /免费|free/i.test(`${m.name} ${m.description ?? ''}`));
    console.log(`== ${connector.provider}: ${models.length} models, ${free.length} free now`);
    for (const model of models.slice(0, 4)) console.log(`   ${model.id} | ${model.name}`);
    if (free.length > 0) console.log(`   free: ${free.map((m) => m.id).join(', ')}`);
    if (LIVE && free.length > 0) await summarize(connector.provider, free[0].id);
  } catch (error) {
    console.log(`== ${connector.provider}: ERROR ${error && error.message ? error.message : error}`);
  }
}

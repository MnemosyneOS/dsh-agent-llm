#!/usr/bin/env node
/**
 * Live smoke test for dsh-agent-llm connectors (run manually, free models only).
 *
 *   node tests/live-smoke.mjs            # catalogs only, no network/credits
 *   node tests/live-smoke.mjs --live     # stream one free model per provider
 */
import { createWorkBuddyConnector } from '../lib/workbuddy-connector.js';
import { createHermesConnector } from '../lib/hermes-connector.js';
import { AgentLlmAdapter } from '../lib/adapter.js';

const LIVE = process.argv.includes('--live');
const homedir = process.env.USERPROFILE;
const local = process.env.LOCALAPPDATA;

const workbuddyAi = createWorkBuddyConnector({
  provider: 'workbuddy-ai',
  displayName: 'WorkBuddy AI',
  sourceLabel: 'WorkBuddy AI',
  dataRoot: `${homedir}\\.workbuddy-ai`,
  authFile: `${local}\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info`,
  exeCandidates: ['C:\\AI_Workspace\\01_Agents\\WorkBuddyAI\\WorkBuddyAI.exe'],
  appVersion: '5.8.4',
});
const workbuddy = createWorkBuddyConnector({
  provider: 'workbuddy',
  displayName: 'WorkBuddy',
  sourceLabel: 'WorkBuddy',
  dataRoot: `${homedir}\\.workbuddy`,
  authFile: `${local}\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info`,
  exeCandidates: ['C:\\AI_Workspace\\01_Agents\\WorkBuddyAI\\WorkBuddyAI.exe', `${local}\\Programs\\WorkBuddy\\WorkBuddy.exe`],
  appVersion: '5.8.3',
});
const hermes = createHermesConnector({
  provider: 'hermes-agent',
  displayName: 'Hermes Agent',
  home: 'C:\\AI_Workspace\\01_Agents\\HermesAgent\\home',
});

const adapter = new AgentLlmAdapter([workbuddyAi, workbuddy, hermes]);

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
  for await (const chunk of adapter.stream({ provider, model, messages, tools, maxTokens: 256, signal: AbortSignal.timeout(120000) })) {
    chunks.push(chunk);
  }
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('');
  const toolCalls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').map((c) => c.block);
  const usage = chunks.find((c) => c.type === 'usage')?.usage;
  const finish = chunks.find((c) => c.type === 'finish')?.reason;
  console.log(`  [${provider}/${model}] ${Date.now() - started}ms chunks=${chunks.length} finish=${JSON.stringify(finish)}`);
  console.log(`    text=${JSON.stringify(text.slice(0, 160))}`);
  if (reasoning) console.log(`    reasoning_len=${reasoning.length}`);
  if (toolCalls.length) console.log(`    tool_calls=${JSON.stringify(toolCalls).slice(0, 500)}`);
  console.log(`    usage=${JSON.stringify(usage)}`);
}

for (const [name, connector] of [
  ['workbuddy-ai', workbuddyAi],
  ['workbuddy', workbuddy],
  ['hermes-agent', hermes],
]) {
  try {
    const models = await adapter.listModels(name);
    const free = models.filter((m) => /免费|free/i.test(`${m.name} ${m.description ?? ''}`));
    console.log(`== ${name}: ${models.length} models, ${free.length} free now`);
    for (const model of models.slice(0, 4)) console.log(`   ${model.id} | ${model.name}`);
    if (free.length > 0) console.log(`   free: ${free.map((m) => m.id).join(', ')}`);
    if (LIVE && free.length > 0) {
      const target = name === 'hermes-agent' ? free.find((m) => m.id.endsWith(':free')) ?? free[0] : free[0];
      await summarize(name, target.id);
    }
  } catch (error) {
    console.log(`== ${name}: ERROR ${error && error.message ? error.message : error}`);
  }
}

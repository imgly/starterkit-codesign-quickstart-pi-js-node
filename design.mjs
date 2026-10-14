// A brief in, a finished design out: pi runs the model through IMG.LY's gateway, the engine runs in one local executor.
import { mkdir, writeFile } from 'node:fs/promises';

import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import {
  googleFonts,
  prepareCoDesign,
  remoteExecutors
} from '@imgly/codesign-sdk';

const brief = process.argv[2];
const missing = [
  ...(brief ? [] : ['a brief (the first argument)']),
  ...['IMGLY_CESDK_LICENSE', 'EXECUTOR_TOKEN'].filter((n) => !process.env[n])
];
if (missing.length > 0) {
  console.error(
    `Missing ${missing.join(', ')}.\nUsage: npm start -- "<brief>", with the variables of .env.template set in .env` +
      (process.env.IMGLY_CESDK_LICENSE
        ? ''
        : '\nContact sales (https://img.ly/forms/contact-sales/) to get a CoDesign license key.')
  );
  process.exit(1);
}

// IMG.LY's AI gateway speaks OpenAI's Chat Completions; your CoDesign license key is its API key.
/** @type {import('@earendil-works/pi-ai').Model<'openai-completions'>} */
const model = {
  id: process.env.MODEL || '@openrouter/anthropic/claude-opus-5',
  name: 'Design model through IMG.LY',
  api: 'openai-completions',
  provider: 'imgly-gateway', // any name; pi only labels with it
  baseUrl: 'https://gateway.img.ly/v1',
  reasoning: true,
  input: ['text', 'image'], // tool results carry renders of the design
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // the gateway bills; pi's estimate stays 0
  contextWindow: 1_000_000,
  maxTokens: 16_000
};

const codesign = prepareCoDesign({
  // Your id for this job. Every design of a conversation opens on one executor
  // that serves no other conversation. Every run here is yours, so all share one.
  conversation: 'quickstart',
  executors: remoteExecutors({
    // The executor for a conversation. Here there is one; a product starts a
    // new one for each conversation.
    acquire: () => ({
      url: process.env.EXECUTOR_URL || 'http://localhost:8080'
    }),
    token: process.env.EXECUTOR_TOKEN
  }),
  // The CE.SDK plugins the engine applies: everything the agent can search and
  // place. Google Fonts is the smallest useful list; your own plugins go here.
  plugins: [googleFonts()],
  design: `quickstart-${Date.now()}`, // any id; with no `designs` store, the design lives in memory
  gateway: false // no image generation; the model still runs through the gateway
});

// The SDK's tools in pi's shape. pi moves renders out of tool results itself,
// so the model sees its work on Chat Completions too.
const tools = codesign.tools.map((t) => ({
  name: t.name,
  label: t.name,
  description: t.description ?? '',
  parameters:
    /** @type {import('@earendil-works/pi-agent-core').AgentTool['parameters']} */ (
      t.inputSchema
    ), // plain JSON Schema; pi types it as TypeBox's
  execute: async (_id, params, signal) => {
    const result = await t.call(params ?? {}, { signal });
    if (result.isError)
      throw new Error(
        result.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
      ); // the model reads it as a failed call
    return { content: result.content, details: {} };
  }
}));

const agent = new Agent({
  initialState: {
    systemPrompt: `You design marketing visuals. When you are done, say in one sentence what you made.\n\n${codesign.instructions}`,
    model,
    thinkingLevel: 'medium',
    tools
  },
  // No convertToLlm filter: pi sends the system prompt and the tools as a system message, and a filter that drops it sends neither.
  streamFn: streamSimple,
  getApiKey: () => process.env.IMGLY_CESDK_LICENSE
});
agent.subscribe((e) => {
  if (e.type === 'tool_execution_end')
    console.log(`${e.isError ? '✗' : '✓'} ${e.toolName}`);
});

/** A failure in one line: the SDK error's kind and the first line of its message, not a stack or a request body. */
const cause = (err) =>
  `${err?.kind ? `${err.kind}: ` : ''}${String(err instanceof Error ? err.message : err).split('\n')[0]}`;

// The free .imgly first: when the billed PNG export fails, or the run ends early, the design the model made is kept.
async function save(withPNG) {
  let file = 'out/design.imgly';
  try {
    await mkdir('out', { recursive: true });
    await writeFile(file, await codesign.export('imgly'));
    if (!withPNG) return console.error(`Wrote ${file}, the design so far.`);
    file = 'out/design.png';
    await writeFile(file, await codesign.export('png'));
    console.log('Wrote out/design.png and out/design.imgly');
  } catch (err) {
    console.error(`Could not write ${file}: ${cause(err)}`);
    process.exitCode = 1;
  }
}

const started = Date.now();
try {
  await agent.prompt(brief);
} catch (err) {
  console.error(`The run failed: ${cause(err)}`);
}
const last = agent.state.messages.at(-1);
const seconds = Math.round((Date.now() - started) / 1000);
// pi does not throw when the gateway refuses (402 when the credits run out): the error is in the last message.
if (last?.role !== 'assistant' || last.stopReason === 'error') {
  console.error(
    `The run ended with an error after ${seconds} s: ${last?.role === 'assistant' ? last.errorMessage : 'no answer'}`
  );
  process.exitCode = 1;
  await save(false);
} else {
  console.log(
    `\n${last.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('')}`
  );
  const answers = agent.state.messages.filter((m) => m.role === 'assistant');
  const usage = (key) => answers.reduce((sum, m) => sum + m.usage[key], 0);
  const input = usage('input') + usage('cacheRead') + usage('cacheWrite');
  console.log(
    `${answers.length} steps, ${seconds} s, ${input} input / ${usage('output')} output tokens`
  );
  await save(true);
}
await codesign.release(); // ends the design's session now; the engine closes about 30 s later

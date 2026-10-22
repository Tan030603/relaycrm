import { ServiceUnavailableException } from '@nestjs/common';
import { log } from './infra';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';

export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;

/**
 * One structured call to Claude: the model must answer by "calling" a tool whose input
 * schema is the shape we want, so the result is JSON we validate, never free text we parse.
 */
export async function askClaude<T>(opts: { system: string; prompt: string; tool: string; schema: Record<string, unknown>; maxTokens?: number }): Promise<T> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ServiceUnavailableException('AI is not configured (set ANTHROPIC_API_KEY)');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      tools: [{ name: opts.tool, description: 'Return the answer', input_schema: opts.schema }],
      tool_choice: { type: 'tool', name: opts.tool },
      messages: [{ role: 'user', content: opts.prompt }],
    }),
  });
  if (!res.ok) {
    log.warn({ status: res.status, body: (await res.text()).slice(0, 300) }, 'claude call failed');
    throw new ServiceUnavailableException('AI is unavailable right now');
  }
  const data = (await res.json()) as { content: { type: string; input?: unknown }[] };
  const block = data.content.find((c) => c.type === 'tool_use');
  if (!block?.input) throw new ServiceUnavailableException('AI returned no answer');
  return block.input as T;
}

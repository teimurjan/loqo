import { MockLanguageModelV4 } from 'ai/test';
import { type Envelope, fromEnvelope, toEnvelope } from '../../src/core/pipeline/llm';

export type Fields = Record<string, string>;

/** A "model" that answers the envelope with whatever `transform` makes of the fields and the system prompt. */
export const fakeModel = (transform: (fields: Fields, system: string) => Fields | Promise<Fields>) =>
  new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const system = prompt.find((message) => message.role === 'system');
      const user = prompt.find((message) => message.role === 'user');
      const systemText = system?.role === 'system' ? system.content : '';
      const userText = user?.role === 'user' && user.content[0]?.type === 'text' ? user.content[0].text : '';
      const fields = fromEnvelope(JSON.parse(userText) as Envelope);
      return {
        content: [{ type: 'text', text: JSON.stringify(toEnvelope(await transform(fields, systemText))) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });

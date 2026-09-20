import { z } from 'zod';

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'llama3.2';
const DEFAULT_TIMEOUT_MS = 25_000;

/** A model that answers with JSON matching a schema. An interface so debates are testable with no model. */
export type Llm = {
  json<T>(input: { system: string; user: string; schema: z.ZodType<T> }): Promise<T>;
};

export type OllamaOptions = { host?: string; model?: string; timeoutMs?: number };

/**
 * Local Ollama over its `/api/chat` endpoint with structured output (`format` = a JSON schema,
 * `stream: false`). Ollama is on this laptop, so no source or transcript leaves it (CLAUDE.md
 * rule 7). Every caller has a deterministic fallback, so a failure here is thrown, never hidden.
 */
export class OllamaClient implements Llm {
  private readonly host: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaOptions = {}) {
    this.host = (options.host ?? process.env.OLLAMA_HOST ?? DEFAULT_HOST).replace(/\/$/, '');
    this.model = options.model ?? process.env.AGENTIGRAM_ORCH_MODEL ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async json<T>(input: { system: string; user: string; schema: z.ZodType<T> }): Promise<T> {
    const response = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: z.toJSONSchema(input.schema),
        options: { temperature: 0.4 },
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
      }),
    });
    if (!response.ok) throw new Error(`ollama ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { message?: { content?: string } };
    const content = body.message?.content;
    if (!content) throw new Error('ollama returned no content');
    return input.schema.parse(JSON.parse(content));
  }
}

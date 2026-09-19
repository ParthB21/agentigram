import { DEFAULT_PERSONAS, type PersonaLine, render } from '@agentigram/personas';
import { EventSchema } from '@agentigram/protocol';
import { generateObject } from 'ai';
import { z } from 'zod';

const RequestSchema = z.object({ events: z.array(EventSchema).max(20) });
const LinesSchema = z.object({
  lines: z.array(
    z.object({
      speaker: z.string(),
      text: z.string().max(220),
      seq: z.number().int().nonnegative(),
    }),
  ),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: 'Invalid event window.' }, { status: 400 });

  const notableRenderer = process.env.AI_GATEWAY_API_KEY
    ? async (): Promise<PersonaLine[]> => {
        const result = await generateObject({
          model: process.env.PERSONA_MODEL ?? 'openai/gpt-5-mini',
          schema: LinesSchema,
          system:
            'Render concise dialogue about code, never people. Preserve each source seq exactly. Do not invent facts, instructions, or events.',
          prompt: JSON.stringify({ events: parsed.data.events, personas: DEFAULT_PERSONAS }),
        });
        return result.object.lines;
      }
    : undefined;

  try {
    const lines = await render(parsed.data.events, DEFAULT_PERSONAS, { notableRenderer });
    return Response.json({ lines, mode: notableRenderer ? 'ai' : 'templates' });
  } catch {
    const lines = await render(parsed.data.events, DEFAULT_PERSONAS);
    return Response.json({ lines, mode: 'templates' });
  }
}

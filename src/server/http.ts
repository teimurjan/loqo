import { ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string): HttpError => new HttpError(404, `${what} not found`);

export const json = (body: unknown, status = 200): Response => Response.json(body, { status });

export const parseBody = async <T>(req: Request, schema: ZodType<T>): Promise<T> => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
  return parseWith(schema, raw);
};

/** For POSTs where the body is optional: an empty body parses as `{}`. */
export const parseOptionalBody = async <T>(req: Request, schema: ZodType<T>): Promise<T> => {
  const text = await req.text();
  if (text.trim().length === 0) return parseWith(schema, {});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
  return parseWith(schema, raw);
};

export const parseQuery = <T>(req: Request, schema: ZodType<T>): T =>
  parseWith(schema, Object.fromEntries(new URL(req.url).searchParams.entries()));

const parseWith = <T>(schema: ZodType<T>, raw: unknown): T => {
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(400, 'Invalid request', result.error.issues);
  return result.data;
};

export const errorResponse = (error: unknown): Response => {
  if (error instanceof HttpError) return json({ error: error.message, details: error.details }, error.status);
  if (error instanceof ZodError) return json({ error: 'Invalid request', details: error.issues }, 400);
  console.error(error);
  return json({ error: error instanceof Error ? error.message : 'Internal error' }, 500);
};

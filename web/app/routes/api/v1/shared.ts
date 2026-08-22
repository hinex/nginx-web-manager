import { authenticate, type AuthContext } from "~/lib/auth/authenticate";
import {
  ForbiddenError,
  NotFoundError,
  InvalidPathError,
  HostValidationError,
  InputValidationError,
  ConfigClassificationError,
} from "~/lib/services/errors";

/** Snake-case the error class name: e.g. "ForbiddenError" → "forbidden_error" */
function toCode(name: string): string {
  return name
    .replace(/([A-Z])/g, (m, l, offset) => (offset > 0 ? "_" : "") + l.toLowerCase())
    .replace(/^_/, "");
}

/**
 * Map a thrown error to a JSON Response.
 * ForbiddenError → 403, NotFoundError → 404, InvalidPathError → 400,
 * HostValidationError → 422, ConfigClassificationError → 409, unknown → 500.
 */
export function toResponse(err: unknown): Response {
  if (err instanceof ForbiddenError) {
    return Response.json(
      { error: err.message, code: toCode(err.name) },
      { status: 403 }
    );
  }
  if (err instanceof NotFoundError) {
    return Response.json(
      { error: err.message, code: toCode(err.name) },
      { status: 404 }
    );
  }
  if (err instanceof InvalidPathError) {
    return Response.json(
      { error: err.message, code: toCode(err.name) },
      { status: 400 }
    );
  }
  if (err instanceof InputValidationError) {
    return Response.json(
      { error: err.message, code: toCode(err.name) },
      { status: 400 }
    );
  }
  if (err instanceof HostValidationError) {
    return Response.json(
      { error: err.message, code: toCode(err.name) },
      { status: 422 }
    );
  }
  if (err instanceof ConfigClassificationError) {
    // 409 Conflict: the submitted text conflicts with the host model. Not a
    // 400 — the request is well-formed, and clients must tell the two apart
    // to know whether retrying with the same body could ever succeed.
    return Response.json(
      {
        error: err.message,
        code: toCode(err.name),
        refusals: err.refusals.map((r) => ({ line: r.line, directive: r.directive, reason: r.reason })),
      },
      { status: 409 }
    );
  }
  console.error("[api/v1] unhandled error:", err);
  return Response.json({ error: "Internal server error", code: "internal_error" }, { status: 500 });
}

/**
 * Parse the request body as JSON, returning a 400 Response on malformed input.
 * Mirrors the -32700 lesson from mcp.tsx.
 */
export async function parseJsonBody(
  request: Request
): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
  try {
    const data = await request.json();
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      response: Response.json(
        { error: "Parse error: invalid JSON", code: "parse_error" },
        { status: 400 }
      ),
    };
  }
}

/**
 * Thin wrapper over authenticate() that converts its thrown Responses to 401 JSON.
 */
export async function requireAuth(
  request: Request
): Promise<{ ok: true; auth: AuthContext } | { ok: false; response: Response }> {
  try {
    const auth = await authenticate(request);
    return { ok: true, auth };
  } catch (err) {
    if (err instanceof Response) {
      const body = await err.json().catch(() => ({ error: "Authentication required" }));
      return {
        ok: false,
        response: Response.json(
          { error: body?.error ?? "Authentication required", code: "unauthorized" },
          { status: 401 }
        ),
      };
    }
    throw err;
  }
}

/**
 * Parse a route param as a positive safe integer.
 * Returns the integer or null on failure.
 * Rejects: non-decimal, zero, negative, non-integers, values > Number.MAX_SAFE_INTEGER.
 */
export function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw || raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

/** 405 Method Not Allowed JSON response */
export function methodNotAllowed(allowed: string[]): Response {
  return Response.json(
    { error: `Method not allowed`, code: "method_not_allowed" },
    {
      status: 405,
      headers: { Allow: allowed.join(", ") },
    }
  );
}

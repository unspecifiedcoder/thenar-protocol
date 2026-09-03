/**
 * PLAN §12: every error is `{ error: { code, message, details? } }`. The
 * code list is closed — a handler that wants to signal something outside
 * this list is a sign the route is not doing what PLAN says, not a reason
 * to invent a ninth code.
 */
export const ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "unprocessable",
  "rate_limited",
  "not_implemented",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  rate_limited: 429,
  not_implemented: 501,
  internal: 500,
};

export class ApiError extends Error {
  code: ErrorCode;
  status: number;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export function errorBody(code: ErrorCode, message: string, details?: unknown) {
  const error: { code: ErrorCode; message: string; details?: unknown } = { code, message };
  if (details !== undefined) error.details = details;
  return { error };
}

export function statusOf(code: ErrorCode): number {
  return STATUS[code];
}

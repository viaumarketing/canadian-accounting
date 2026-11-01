export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public issues?: { path: string; message: string }[]) {
    super(message);
  }
}

/** All calls go to same-origin /api/* (proxied to the Nest API), so the httpOnly session cookie just works. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'ca-web',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.code ?? 'ERROR', data.message ?? 'Request failed', data.issues);
  return data as T;
}

export const errorMessage = (e: unknown) =>
  e instanceof ApiError
    ? e.issues?.length
      ? `${e.message}: ${e.issues.map((i) => i.message).join('; ')}`
      : e.message
    : 'Something went wrong';

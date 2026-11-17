export async function requestJson<T>(base: string, pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(pathname, base), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

export async function command<T>(base: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const result = await fetch(`${base.replace(/\/api\/?$/, "")}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: name, arguments: args }), ...(signal ? { signal } : {}) });
  if (!result.ok) throw new Error(result.status === 409 ? "conflict" : "unavailable");
  return result.json();
}

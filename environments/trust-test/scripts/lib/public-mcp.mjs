let sequence = 0;

export async function publicMcp(endpoint, name, args) {
  const id = `trust-mcp-${++sequence}`;
  const response = await fetch(new URL("/mcp", endpoint), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`MCP ${name}: HTTP ${response.status}`);
  const envelope = await response.json();
  const text = envelope.result?.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (envelope.id !== id || envelope.error || envelope.result?.isError || text === undefined) {
    throw new Error(envelope.error?.message ?? text ?? `Invalid MCP response for ${name}`);
  }
  return text;
}

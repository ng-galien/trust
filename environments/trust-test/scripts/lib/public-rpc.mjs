let sequence = 0;

export async function publicRpc(endpoint, method, params, credential, processCredential) {
  const id = `trust-server-${++sequence}`;
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
    ...(processCredential === undefined
      ? {}
      : { "x-trust-process-authorization": `Bearer ${processCredential}` }),
  };
  const response = await fetch(normalizeRpcEndpoint(endpoint), {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`TRUST RPC ${method} failed with HTTP ${response.status}`);
  }
  const envelope = await response.json();
  if (
    envelope === null
    || typeof envelope !== "object"
    || Array.isArray(envelope)
    || envelope.jsonrpc !== "2.0"
    || envelope.id !== id
  ) {
    throw new TypeError(`TRUST RPC ${method} returned an invalid envelope`);
  }
  if (Object.hasOwn(envelope, "error")) {
    // Show everything the runtime says: reason code, message and source location when it is a compile error.
    const data = envelope.error?.data ?? {};
    const str = (value) => (typeof value === "string" ? value : undefined);
    const parts = [
      str(data.reason),
      str(data.message) ?? str(envelope.error?.message),
      typeof data.location?.line === "number" ? `line ${data.location.line}` : undefined,
      str(data.sourceName),
    ].filter(Boolean);
    throw new Error(`TRUST RPC ${method} was rejected${parts.length ? `: ${parts.join(" — ")}` : ""}`);
  }
  if (!Object.hasOwn(envelope, "result")) {
    throw new TypeError(`TRUST RPC ${method} returned no result`);
  }
  return envelope.result;
}

function normalizeRpcEndpoint(value) {
  const endpoint = new URL(value);
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.search !== ""
    || endpoint.hash !== ""
  ) {
    throw new TypeError("TRUST RPC endpoint must be an absolute credential-free HTTP URL");
  }
  endpoint.pathname = endpoint.pathname.endsWith("/rpc")
    ? endpoint.pathname
    : `${endpoint.pathname.replace(/\/$/, "")}/rpc`;
  return endpoint.href;
}

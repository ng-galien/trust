const DNS_AUTHORITY = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const IPV4_AUTHORITY = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const SECRET_LIKE = /(?:^|[^a-z0-9])(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9]{8,}|bearer\s+[a-z0-9._-]{8,})/i;

export function assertNoSecretLikeValue(value: string, label: string): void {
  if (SECRET_LIKE.test(value)) {
    throw new TypeError(`${label} contains a secret-like value`);
  }
}

export function normalizeAuthority(authority: string): string {
  assertNoSecretLikeValue(authority, "authority");

  if (
    authority !== authority.toLowerCase() ||
    authority.includes("@") ||
    authority.includes("/") ||
    authority.includes("?") ||
    authority.includes("#")
  ) {
    throw new TypeError("Authority must be a lowercase host with an optional port");
  }

  const separator = authority.lastIndexOf(":");
  const hasPort = separator > -1;
  const host = hasPort ? authority.slice(0, separator) : authority;
  const portText = hasPort ? authority.slice(separator + 1) : undefined;

  if (!host || (!DNS_AUTHORITY.test(host) && !isValidIpv4(host))) {
    throw new TypeError("Authority host is invalid");
  }

  if (portText !== undefined) {
    if (!/^\d+$/.test(portText)) {
      throw new TypeError("Authority port is invalid");
    }
    const port = Number(portText);
    if (port < 1 || port > 65_535 || String(port) !== portText) {
      throw new TypeError("Authority port is invalid");
    }
  }

  return authority;
}

function isValidIpv4(host: string): boolean {
  if (!IPV4_AUTHORITY.test(host)) {
    return false;
  }
  return host.split(".").every((part) => Number(part) <= 255 && String(Number(part)) === part);
}

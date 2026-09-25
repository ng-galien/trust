import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";

const defaultOrigins = "https://fcm.googleapis.com";

export function pushConfiguration(configuration) {
  const subject = configuration.pushSubject?.trim() ?? "";
  if (subject && !validSubject(subject)) throw new Error("pushSubject must be a mailto: or HTTPS URL.");
  const origins = (configuration.pushAllowedOrigins ?? defaultOrigins).split(",").map((entry) => entry.trim());
  if (origins.some((entry) => !validOrigin(entry))) throw new Error("Invalid pushAllowedOrigins entry.");
  return { subject, origins: new Set(origins) };
}

function validSubject(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "mailto:" && !!url.pathname) || (url.protocol === "https:" && !!url.hostname);
  } catch {
    return false;
  }
}

function validOrigin(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))
    );
  } catch {
    return false;
  }
}

export function validatePushEndpoint(value, origins) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && origins.has(url.origin);
  } catch {
    return false;
  }
}

export async function preparePushKeys(db) {
  const existing = (await db.query("SELECT 1 FROM trust_mobile_companion.push_keys WHERE id=1")).rows;
  if (existing.length) return;
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const publicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url");
  await db.query(
    "INSERT INTO trust_mobile_companion.push_keys(id,public_key,private_key) VALUES(1,$1,$2) ON CONFLICT(id) DO NOTHING",
    [publicKey, jwk.d],
  );
}

function vapidAuthorization(endpoint, subject, publicKey, privateKey) {
  const point = Buffer.from(publicKey, "base64url");
  if (point.length !== 65 || point[0] !== 4) throw new Error("Invalid prepared VAPID public key.");
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
      d: privateKey,
    },
    format: "jwk",
  });
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }),
  ).toString("base64url");
  const token = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(token), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `vapid t=${token}.${signature}, k=${publicKey}`;
}

export async function createPushDispatcher(db, configuration) {
  const settings = pushConfiguration(configuration);
  const key = (await db.query("SELECT public_key,private_key FROM trust_mobile_companion.push_keys WHERE id=1"))
    .rows[0];
  if (!key) throw new Error("Mobile companion requires prepared push keys.");
  let work;
  let closed = false;
  async function status() {
    const pending = (
      await db.query(
        "SELECT count(*)::integer AS count FROM trust_mobile_companion.push_deliveries WHERE state='pending'",
      )
    ).rows[0].count;
    return { enabled: !!settings.subject, publicKey: settings.subject ? key.public_key : null, pending };
  }
  async function subscribe(endpoint) {
    if (!settings.subject) throw new Error("Push is not configured.");
    if (!validatePushEndpoint(endpoint, settings.origins)) throw new Error("Push endpoint is not allowed.");
    await db.query(
      `INSERT INTO trust_mobile_companion.push_subscriptions(endpoint,active)
      VALUES($1,true) ON CONFLICT(endpoint) DO UPDATE SET active=true`,
      [endpoint],
    );
    return { subscribed: true };
  }
  async function unsubscribe(endpoint) {
    if (typeof endpoint !== "string" || endpoint.length > 4096) throw new Error("Invalid push endpoint.");
    await db.transaction(async (tx) => {
      await tx.query("UPDATE trust_mobile_companion.push_subscriptions SET active=false WHERE endpoint=$1", [endpoint]);
      await tx.query(
        "UPDATE trust_mobile_companion.push_deliveries SET state='cancelled' WHERE endpoint=$1 AND state='pending'",
        [endpoint],
      );
    });
    return { subscribed: false };
  }
  async function deliver() {
    const due = (
      await db.query(
        `SELECT d.item,d.endpoint,d.attempts FROM trust_mobile_companion.push_deliveries d
        JOIN trust_mobile_companion.push_subscriptions s ON s.endpoint=d.endpoint
        WHERE d.state='pending' AND s.active AND d.next_attempt_at<=now()
        ORDER BY d.next_attempt_at,d.item LIMIT 20`,
      )
    ).rows;
    for (const row of due) {
      let code = null;
      if (validatePushEndpoint(row.endpoint, settings.origins)) {
        try {
          const response = await fetch(row.endpoint, {
            method: "POST",
            headers: {
              Authorization: vapidAuthorization(row.endpoint, settings.subject, key.public_key, key.private_key),
              TTL: "86400",
              Urgency: "normal",
            },
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          });
          code = response.status;
          await response.body?.cancel();
        } catch {
          // The durable delivery remains pending for a later attempt.
        }
      } else code = 410;
      if (code === 404 || code === 410) {
        await db.transaction(async (tx) => {
          await tx.query("UPDATE trust_mobile_companion.push_subscriptions SET active=false WHERE endpoint=$1", [
            row.endpoint,
          ]);
          await tx.query(
            "UPDATE trust_mobile_companion.push_deliveries SET state='cancelled',last_status=$2 WHERE endpoint=$1 AND state='pending'",
            [row.endpoint, code],
          );
        });
      } else if (code !== null && code >= 200 && code < 300) {
        await db.query(
          "UPDATE trust_mobile_companion.push_deliveries SET state='delivered',attempts=attempts+1,last_status=$3 WHERE item=$1 AND endpoint=$2",
          [row.item, row.endpoint, code],
        );
      } else {
        const delay = Math.min(3600, 15 * 2 ** Math.min(row.attempts, 8));
        await db.query(
          `UPDATE trust_mobile_companion.push_deliveries SET attempts=attempts+1,last_status=$3,
          next_attempt_at=now()+($4::integer * interval '1 second') WHERE item=$1 AND endpoint=$2`,
          [row.item, row.endpoint, code, delay],
        );
      }
    }
  }
  function kick() {
    if (closed || !settings.subject || work) return;
    work = deliver()
      .catch(() => {})
      .finally(() => {
        work = undefined;
      });
  }
  const timer = settings.subject ? setInterval(kick, 10_000) : null;
  timer?.unref();
  kick();
  return {
    status,
    subscribe,
    unsubscribe,
    kick,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      if (work) await work;
    },
  };
}

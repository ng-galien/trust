import { useCallback, useEffect, useState } from "react";
import { useMobileApi, useMobileTransport } from "./transport";
import type { PushStatus } from "./types";

type NotificationState = "off" | "on" | "blocked" | "unsupported";

export function useNotifications(apiBase: string, reportError: (message: string) => void) {
  const transport = useMobileTransport();
  const { readPushStatus } = useMobileApi();
  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [notificationState, setNotificationState] = useState<NotificationState>("off");
  const [changing, setChanging] = useState(false);
  const commandUrl = `${apiBase.replace(/\/api$/, "")}/commands`;

  const command = useCallback(
    async (name: string, args: object) => {
      const response = await transport.fetch(commandUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: name, arguments: args }),
      });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
    },
    [transport, commandUrl],
  );

  useEffect(() => {
    // The host owns installation identity. Keep the legacy manifest only for a standalone hostless entry.
    const link = document.querySelector('link[rel="manifest"]') ? null : document.createElement("link");
    if (link) {
      link.rel = "manifest";
      link.href = "/mobile/mobile-companion/manifest.webmanifest";
      document.head.append(link);
    }
    let active = true;
    void readPushStatus(apiBase)
      .then(async (status) => {
        if (!active) return;
        setPushStatus(status);
        if (!status.enabled) return;
        if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
          setNotificationState("unsupported");
          return;
        }
        if (Notification.permission === "denied") {
          setNotificationState("blocked");
          return;
        }
        const registration = await navigator.serviceWorker.getRegistration("/mobile/mobile-companion/");
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription && active) {
          await command("notifications.subscribe", { endpoint: subscription.endpoint });
          setNotificationState("on");
        }
      })
      .catch((cause) => {
        if (active) reportError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
      link?.remove();
    };
  }, [apiBase, command, reportError, readPushStatus]);

  const toggle = useCallback(async () => {
    if (!pushStatus?.publicKey || changing) return;
    setChanging(true);
    try {
      if (notificationState === "on") {
        const registration = await navigator.serviceWorker.getRegistration("/mobile/mobile-companion/");
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          await command("notifications.unsubscribe", { endpoint: subscription.endpoint });
          await subscription.unsubscribe();
        }
        setNotificationState("off");
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setNotificationState(permission === "denied" ? "blocked" : "off");
          return;
        }
        const registration = await navigator.serviceWorker.register("/mobile/mobile-companion/sw.js", {
          scope: "/mobile/mobile-companion/",
        });
        const encoded = pushStatus.publicKey.replace(/-/g, "+").replace(/_/g, "/");
        const bytes = Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")), (char) =>
          char.charCodeAt(0),
        );
        const subscription =
          (await registration.pushManager.getSubscription()) ??
          (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes }));
        await command("notifications.subscribe", { endpoint: subscription.endpoint });
        setNotificationState("on");
      }
      reportError("");
    } catch (cause) {
      reportError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChanging(false);
    }
  }, [pushStatus, changing, notificationState, command, reportError]);

  return { pushStatus, notificationState, changingNotifications: changing, toggleNotifications: toggle };
}

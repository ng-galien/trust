if (location.pathname.startsWith("/mobile/mobile-companion")) {
  const session = crypto.randomUUID();
  const agent = navigator.userAgent;
  const platform = /Android/i.test(agent)
    ? "Android"
    : /Macintosh|Mac OS X/i.test(agent)
      ? "macOS"
      : /Windows/i.test(agent)
        ? "Windows"
        : /Linux/i.test(agent)
          ? "Linux"
          : "other";
  const allowed = new Set(["TypeError", "SyntaxError", "ReferenceError", "Error"]);
  const name = (value) => (allowed.has(value?.name) ? value.name : "unknown");
  window.__trustMobileReport = (stage, code) => {
    void fetch("/extensions/mobile-companion/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "client.report", arguments: { stage, code, platform, session } }),
      keepalive: true,
    }).catch(() => {});
  };
  window.__trustMobileReport("host-boot", "started");
  window.addEventListener(
    "error",
    (event) => {
      if (event.target !== window) window.__trustMobileReport("host-resource", "failed");
      else window.__trustMobileReport("host-script", name(event.error));
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) => {
    window.__trustMobileReport("host-script", name(event.reason));
  });
}

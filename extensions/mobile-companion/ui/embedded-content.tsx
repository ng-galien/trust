import { useEffect, useState } from "react";

export function EmbeddedContent({
  url,
  title,
  reader,
  french,
}: {
  url: string;
  title: string;
  reader: boolean;
  french: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"checking" | "ready" | "unavailable">("checking");

  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter deliberately reruns the availability request after the user retries.
  useEffect(() => {
    const controller = new AbortController();
    setState("checking");
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        await response.body?.cancel();
        if (!controller.signal.aborted) setState(response.ok ? "ready" : "unavailable");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("unavailable");
      });
    return () => controller.abort();
  }, [url, attempt]);

  return (
    <section className="mobile-embedded" aria-label={title}>
      {state === "checking" && (
        <p role="status" className="mobile-embedded-notice">
          {french ? "Ouverture du lecteur…" : "Opening reader…"}
        </p>
      )}
      {state === "unavailable" && (
        <div role="alert" className="mobile-embedded-notice">
          <p>
            {reader
              ? french
                ? "Le lecteur Maket est indisponible pour le moment."
                : "The Maket reader is unavailable right now."
              : french
                ? "Cette application est indisponible pour le moment."
                : "This app is unavailable right now."}
          </p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            {french ? "Réessayer" : "Try again"}
          </button>
        </div>
      )}
      {state === "ready" && <iframe title={title} src={url} />}
    </section>
  );
}

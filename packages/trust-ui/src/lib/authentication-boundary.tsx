import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../ui/button.js";
import { LoadingState } from "../ui/states.js";
import type { BrowserAuthentication } from "./authentication.js";

export function AuthenticationBoundary({
  authentication,
  children,
  onSignedOut,
}: {
  authentication: BrowserAuthentication;
  children: ReactNode;
  onSignedOut: () => void;
}) {
  const [state, setState] = useState<"loading" | "ready" | "login" | "failed">("loading");
  const [code, setCode] = useState("");
  useEffect(() => {
    let active = true;
    const unsubscribe = authentication.subscribe((ready) => {
      if (!ready) onSignedOut();
      if (active) setState(ready ? "ready" : "login");
    });
    void authentication
      .initialize()
      .then((ready) => {
        if (active) setState(ready ? "ready" : "login");
      })
      .catch(() => {
        if (active) setState("failed");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [authentication, onSignedOut]);
  if (state === "ready")
    return (
      <>
        {authentication.required && (!authentication.development || authentication.localDevelopment) && (
          <div className="flex justify-end px-4 py-1">
            <Button
              onClick={() => {
                void authentication.logout();
              }}
            >
              Sign out of TRUST
            </Button>
          </div>
        )}
        {children}
      </>
    );
  if (state === "loading") return <LoadingState />;
  return (
    <main className="p-8">
      <h1 className="text-xl">TRUST</h1>
      <p className="my-4">
        {state === "failed"
          ? "Sign-in is unavailable. Check the server authentication configuration."
          : authentication.development
            ? authentication.localDevelopment
              ? "Enter the one-time code generated on this Mac."
              : "Your Tailnet identity must be allowed by this TRUST development server."
            : "Sign in to access this server."}
      </p>
      {authentication.localDevelopment && (
        <input
          aria-label="One-time development code"
          className="mr-3 rounded border px-3 py-2"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      )}
      <Button
        onClick={() => {
          void authentication.login(authentication.localDevelopment ? code : undefined).catch(() => setState("failed"));
        }}
      >
        {authentication.development && !authentication.localDevelopment ? "Retry Tailnet access" : "Sign in"}
      </Button>
    </main>
  );
}

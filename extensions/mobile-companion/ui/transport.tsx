import type { ExtensionPageProps } from "@trust/extension-sdk";
import { createContext, useContext, useMemo } from "react";
import { createMobileApi } from "./api";

export const MobileTransport = createContext<ExtensionPageProps["transport"] | null>(null);
export function useMobileTransport(): ExtensionPageProps["transport"] {
  const transport = useContext(MobileTransport);
  if (!transport) throw new Error("Mobile host transport is unavailable");
  return transport;
}
export function useMobileApi() {
  const transport = useMobileTransport();
  return useMemo(() => createMobileApi(transport), [transport]);
}

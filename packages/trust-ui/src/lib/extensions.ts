import { useQuery } from "@tanstack/react-query";
import { useRuntime } from "./runtime-context.js";

export interface Extension {
  id: string; title: string; version: string;
  state: "STOPPED" | "PREPARING" | "STARTING" | "RUNNING" | "STOPPING" | "FAILED";
  error?: { code: string; message: string };
  apiBase: string;
  ui?: { name: string; entry: string; module: string };
}

export function useExtensions() {
  const { baseUrl } = useRuntime();
  return useQuery({
    queryKey: ["extensions", baseUrl],
    queryFn: async (): Promise<{ extensions: Extension[] }> => {
      const response = await fetch(`${baseUrl}/extensions`);
      if (!response.ok) throw new Error("Extension request failed");
      return response.json();
    },
    refetchInterval: 5000,
  });
}

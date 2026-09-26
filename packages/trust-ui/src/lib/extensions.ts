import { useQuery } from "@tanstack/react-query";
import type { ExtensionDescriptor } from "@trust/extension-sdk";
import { authenticatedFetch } from "./authentication.js";
import { useRuntime } from "./runtime-context.js";

export function useExtensions() {
  const { baseUrl } = useRuntime();
  return useQuery({
    queryKey: ["extensions", baseUrl],
    queryFn: async (): Promise<{ extensions: ExtensionDescriptor[] }> => {
      const response = await authenticatedFetch(`${baseUrl}/extensions`);
      if (!response.ok) throw new Error("Extension request failed");
      return response.json();
    },
    refetchInterval: 5000,
  });
}

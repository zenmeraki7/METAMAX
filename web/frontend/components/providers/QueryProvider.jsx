import { useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
  MutationCache,
} from "@tanstack/react-query";

/** Provides a stable query cache for the lifetime of the mounted app. */
export function QueryProvider({ children }) {
  const [client] = useState(
    () => new QueryClient({
      queryCache: new QueryCache(),
      mutationCache: new MutationCache(),
    })
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

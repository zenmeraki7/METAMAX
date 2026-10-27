import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { demoShopifyData } from "../data/shopifyData.demo.js";

import {
  fetchShopifyData,
  requestShopifyRefresh,
} from "../services/shopifyData.api.js";

const DEMO_MODE =
  import.meta.env.VITE_SYNC_DEMO_MODE !== "false";

export default function useShopifyData(notify) {
  const [overview, setOverview] = useState(
    DEMO_MODE
      ? demoShopifyData
      : { shopTimeZone: "UTC", sources: [] }
  );

  const [loading, setLoading] = useState(!DEMO_MODE);
  const [error, setError] = useState(null);
  const [busyKeys, setBusyKeys] = useState([]);

  const requestVersion = useRef(0);
  const pending = useRef(new Set());

  const reload = useCallback(async (signal) => {
    if (DEMO_MODE) return;

    const version = ++requestVersion.current;

    setLoading(true);

    try {
      const result = await fetchShopifyData({ signal });

      if (
        signal?.aborted ||
        version !== requestVersion.current
      ) {
        return;
      }

      setOverview(result);
      setError(null);
    } catch (cause) {
      if (
        signal?.aborted ||
        version !== requestVersion.current
      ) {
        return;
      }

      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to load Shopify data."
      );
    } finally {
      if (
        !signal?.aborted &&
        version === requestVersion.current
      ) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (DEMO_MODE) return;

    const controller = new AbortController();

    void reload(controller.signal);

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void reload(controller.signal);
      }
    }, 30_000);

    return () => {
      controller.abort();
      window.clearInterval(interval);
      requestVersion.current += 1;
    };
  }, [reload]);

  const refresh = useCallback(
    async (sourceId = null) => {
      if (DEMO_MODE) {
        notify?.(
          "Demo mode: no Shopify refresh was started."
        );
        return;
      }

      const key = sourceId ?? "all";

      if (
        pending.current.has(key) ||
        pending.current.has("all") ||
        (key === "all" && pending.current.size > 0)
      ) {
        return;
      }

      pending.current.add(key);
      setBusyKeys([...pending.current]);

      try {
        const result = await requestShopifyRefresh(
          sourceId
        );

        notify?.(
          `Refresh queued successfully (${result.jobId}).`
        );

        await reload();
      } catch (cause) {
        notify?.(
          cause instanceof Error
            ? `Refresh failed: ${cause.message}`
            : "Could not request refresh."
        );
      } finally {
        pending.current.delete(key);
        setBusyKeys([...pending.current]);
      }
    },
    [notify, reload]
  );

  return {
    overview,
    loading,
    error,
    isDemo: DEMO_MODE,
    busyKeys,
    reload,
    refresh,
    refreshAll: () => refresh(null),
    refreshSource: (id) => refresh(id),
  };
}

export { useShopifyData };

import { useCallback, useEffect, useRef, useState } from "react";

import { demoShopifyData } from "../data/shopifyData.demo.js";

import {
  fetchShopifyData,
  requestShopifyRefresh,
} from "../services/shopifyData.api.js";

const DEMO_MODE = import.meta.env.VITE_SYNC_DEMO_MODE !== "false";

export default function useShopifyData(notify) {
  const [overview, setOverview] = useState(
    DEMO_MODE ? demoShopifyData : { shopTimeZone: "UTC", sources: [] },
  );

  const [loading, setLoading] = useState(!DEMO_MODE);
  const [error, setError] = useState(null);
  const [busyKeys, setBusyKeys] = useState([]);

  const requestVersion = useRef(0);
  const pending = useRef(new Set());
  const inflight = useRef(null);
  const lifecycle = useRef(null);

  const reload = useCallback(async (signal) => {
    if (DEMO_MODE) return;
    signal ??= lifecycle.current?.signal;
    if (signal?.aborted) return;
    if (inflight.current && !inflight.current.signal?.aborted)
      return inflight.current.promise;
    const request = { signal, promise: null };

    const version = ++requestVersion.current;

    setLoading(true);

    request.promise = (async () => {
      try {
        const result = await fetchShopifyData({ signal });

        if (signal?.aborted || version !== requestVersion.current) {
          return;
        }

        setOverview(result);
        setError(null);
      } catch (cause) {
        if (signal?.aborted || version !== requestVersion.current) {
          return;
        }

        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to load Shopify data.",
        );
      } finally {
        if (!signal?.aborted && version === requestVersion.current) {
          setLoading(false);
        }
        if (inflight.current === request) inflight.current = null;
      }
    })();
    inflight.current = request;
    return request.promise;
  }, []);

  useEffect(() => {
    if (DEMO_MODE) return;

    const controller = new AbortController();
    lifecycle.current = controller;

    let timer;
    async function poll() {
      if (document.visibilityState !== "hidden")
        await reload(controller.signal);
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 30_000);
    }
    void poll();

    return () => {
      controller.abort();
      window.clearTimeout(timer);
      requestVersion.current += 1;
    };
  }, [reload]);

  const refresh = useCallback(
    async (sourceId = null) => {
      if (DEMO_MODE) {
        notify?.("Demo mode: no Shopify refresh was started.");
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
        const result = await requestShopifyRefresh(sourceId);
        if (lifecycle.current?.signal.aborted) return;

        notify?.(`Refresh queued successfully (${result.jobId}).`);

        await reload();
      } catch (cause) {
        if (lifecycle.current?.signal.aborted) return;
        notify?.(
          cause instanceof Error
            ? `Refresh failed: ${cause.message}`
            : "Could not request refresh.",
        );
      } finally {
        pending.current.delete(key);
        if (!lifecycle.current?.signal.aborted)
          setBusyKeys([...pending.current]);
      }
    },
    [notify, reload],
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

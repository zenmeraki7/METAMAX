import { useCallback, useEffect, useState } from "react";
import {
  fetchProductCatalog,
  fetchProductCatalogStatus,
  publishedRevision,
  retainCatalogData,
} from "../services/products.api.js";

export default function useProductCatalog(initialSearch = "") {
  const [search, setSearchInput] = useState(initialSearch);
  const [filters, setFilters] = useState({
    search: initialSearch.trim(),
    status: "ALL",
    conditions: [],
    match: "all",
  });
  const [cursors, setCursors] = useState([""]);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [awaitingInitialSync, setAwaitingInitialSync] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [autoRefreshAvailable, setAutoRefreshAvailable] = useState(null);
  const cursor = cursors.at(-1);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  const setSearch = useCallback(
    (value) => {
      if (value === search) return;
      setSearchInput(value);
      setCursors([""]);
      setData(null);
      setLoading(true);
    },
    [search],
  );
  const setStatus = useCallback((status) => {
    setFilters((current) => ({ ...current, status: status.toUpperCase() }));
    setCursors([""]);
    setData(null);
    setLoading(true);
  }, []);
  const setAdvancedFilters = useCallback((conditions, match) => {
    const normalizedConditions = Array.isArray(conditions)
      ? conditions.map((item) => ({
          ...item,
          operator: item.operator === "ne" ? "neq" : item.operator,
        }))
      : [];
    setFilters((current) => ({
      ...current,
      conditions: normalizedConditions,
      match,
    }));
    setCursors([""]);
    setData(null);
    setLoading(true);
  }, []);
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setFilters((current) =>
          current.search === search.trim()
            ? current
            : { ...current, search: search.trim() },
        ),
      300,
    );
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    // Abort the previous query immediately, before the search debounce expires.
    if (search.trim() !== filters.search) return;
    let active = true,
      timer,
      request,
      running = false,
      resume = false;
    let nextKind = "catalog",
      catalog = null,
      failures = 0,
      stopped = false;
    const visible = () => document.visibilityState !== "hidden";
    setAutoRefreshAvailable(null);
    function schedule(delay) {
      clearTimeout(timer);
      if (active && !stopped && visible())
        timer = setTimeout(() => run(true), delay);
    }
    async function readCatalog(signal) {
      const result = await fetchProductCatalog({ ...filters, cursor, signal });
      if (!active || signal.aborted) return;
      catalog = result;
      setAwaitingInitialSync(false);
      setData((previous) => retainCatalogData(previous, result));
      nextKind = "status";
    }
    async function run(background = false) {
      if (!active || stopped || running || !visible()) return;
      running = true;
      const controller = new AbortController();
      request = controller;
      let delay;
      if (!background) setLoading(true);
      try {
        if (nextKind === "catalog") {
          await readCatalog(controller.signal);
        } else {
          const status = await fetchProductCatalogStatus({
            signal: controller.signal,
          });
          if (!active || controller.signal.aborted) return;
          // A timestamp or snapshot ID alone cannot detect in-place webhook
          // updates. Both APIs must expose the same opaque publication revision.
          if (publishedRevision(catalog) === undefined) {
            stopped = true;
            setAutoRefreshAvailable(false);
            return;
          }
          setAutoRefreshAvailable(true);
          if (status.snapshotId !== catalog.snapshotId && cursor) {
            setCursors([""]);
            setData(null);
            reload();
            return;
          }
          if (
            status.snapshotId !== catalog.snapshotId ||
            publishedRevision(status) !== publishedRevision(catalog)
          ) {
            await readCatalog(controller.signal);
          } else if (status.syncStatus !== catalog.syncStatus) {
            catalog = { ...catalog, syncStatus: status.syncStatus };
            setData((previous) => retainCatalogData(previous, catalog));
          }
        }
        if (!active || controller.signal.aborted) return;
        failures = 0;
        setError(null);
        delay = catalog?.syncStatus === "READY" ? 30000 : 5000;
      } catch (failure) {
        if (!active || controller.signal.aborted) return;
        if (!catalog && failure.code === "FILTER_COVERAGE_UNAVAILABLE") {
          setAwaitingInitialSync(true);
          setError(null);
          delay = 5000;
        } else if (failure.statusUnavailable) {
          // Do not fall back to repeatedly downloading rows on older backends.
          stopped = true;
          setAutoRefreshAvailable(false);
        } else if (failure.code === "CATALOG_SNAPSHOT_CHANGED") {
          setCursors([""]);
          setData(null);
          reload();
        } else {
          setError(failure.message);
          if (failure.retryable === true)
            delay = Math.min(30000, 5000 * 2 ** failures++);
          else stopped = true;
        }
      } finally {
        running = false;
        if (active) {
          setLoading(false);
          if (resume && visible() && !stopped) {
            resume = false;
            void run(true);
          } else if (delay !== undefined) schedule(delay);
        }
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      if (!visible()) {
        resume = false;
        request?.abort();
      } else if (running) resume = true;
      else void run(true);
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    void run();
    return () => {
      active = false;
      request?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [filters, cursor, search, refresh, reload]);
  const nextPage = () => {
    if (!loading && data?.pageInfo.hasNextPage) {
      setCursors((current) => [...current, data.pageInfo.endCursor]);
    }
  };
  const previousPage = () => {
    if (!loading && cursors.length > 1) {
      setCursors((current) => current.slice(0, -1));
    }
  };
  return {
    data,
    awaitingInitialSync,
    error,
    loading,
    search,
    setSearch,
    status: filters.status,
    setStatus,
    conditions: filters.conditions,
    match: filters.match,
    setAdvancedFilters,
    reload,
    autoRefreshAvailable,
    nextPage,
    previousPage,
    hasPreviousPage: cursors.length > 1,
    page: cursors.length,
  };
}

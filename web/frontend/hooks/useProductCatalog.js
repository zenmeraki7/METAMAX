import { useCallback, useEffect, useState } from "react";
import { fetchProductCatalog } from "../services/products.api.js";

export default function useProductCatalog() {
  const [search, setSearchInput] = useState("");
  const [filters, setFilters] = useState({ search: "", status: "ALL" });
  const [cursors, setCursors] = useState([""]);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
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
    [search]
  );
  const setStatus = useCallback((status) => {
    setFilters((current) => ({ ...current, status: status.toUpperCase() }));
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
            : { ...current, search: search.trim() }
        ),
      300
    );
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    // Invalidate the old request as soon as input changes, before debounce ends.
    if (search.trim() !== filters.search) return;
    const controller = new AbortController();
    let active = true,
      timer,
      failures = 0;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchProductCatalog({
          ...filters,
          cursor,
          signal: controller.signal,
        });
        if (!active) return;
        failures = 0;
        setData(result);
        // Poll the published view as webhooks update it. Serial requests prevent
        // a slow response from overwriting a newer filter/page or publication.
        timer = setTimeout(load, result.syncStatus === "READY" ? 30000 : 5000);
      } catch (failure) {
        if (!active || controller.signal.aborted) return;
        if (failure.code === "CATALOG_SNAPSHOT_CHANGED") {
          setCursors([""]);
          setData(null);
          reload();
        } else {
          setError(failure.message);
          // A temporary outage must not permanently disconnect the page from
          // import completion or webhook updates. Keep the last published rows
          // and retry serially, with a bounded delay. Auth and other 4xx errors
          // require an explicit refresh instead of an endless retry loop.
          if (!failure.status || failure.status >= 500 || failure.status === 429)
            timer = setTimeout(load, Math.min(30000, 5000 * 2 ** failures++));
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
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
    error,
    loading,
    search,
    setSearch,
    status: filters.status,
    setStatus,
    reload,
    nextPage,
    previousPage,
    hasPreviousPage: cursors.length > 1,
    page: cursors.length,
  };
}

import {
  useCallback,
  useMemo,
  useState,
} from "react";

export default function useHistoryFilters(operations) {
  const [tab, setTab] = useState("All");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const [type, setType] = useState("All");
  const [user, setUser] = useState("All");
  const [dateRange, setDateRange] = useState("Any time");
  const [sortDirection, setSortDirection] =
    useState("desc");

  const users = useMemo(
    () => [...new Set(operations.map((item) => item.user))],
    [operations]
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();

    const days = {
      "Last 7 days": 7,
      "Last 30 days": 30,
      "Last 90 days": 90,
    }[dateRange];

    const cutoff = days
      ? Date.now() - days * 24 * 60 * 60 * 1000
      : null;

    return operations
      .filter((item) => {
        if (tab !== "All" && item.type !== tab) {
          return false;
        }

        if (status !== "All" && item.status !== status) {
          return false;
        }

        if (type !== "All" && item.type !== type) {
          return false;
        }

        if (user !== "All" && item.user !== user) {
          return false;
        }

        if (
          cutoff !== null &&
          new Date(item.startedAt).getTime() < cutoff
        ) {
          return false;
        }

        if (query) {
          const text = [
            item.title,
            item.id,
            item.type,
            item.user,
          ].join(" ").toLocaleLowerCase();

          if (!text.includes(query)) return false;
        }

        return true;
      })
      .sort((a, b) => {
        const delta =
          new Date(a.startedAt).getTime() -
          new Date(b.startedAt).getTime();

        return sortDirection === "asc"
          ? delta
          : -delta;
      });
  }, [
    operations,
    tab,
    search,
    status,
    type,
    user,
    dateRange,
    sortDirection,
  ]);

  const toggleSort = useCallback(() => {
    setSortDirection((current) =>
      current === "desc" ? "asc" : "desc"
    );
  }, []);

  const clearFilters = useCallback(() => {
    setTab("All");
    setSearch("");
    setStatus("All");
    setType("All");
    setUser("All");
    setDateRange("Any time");
  }, []);

  const hasFilters =
    tab !== "All" ||
    search.trim() !== "" ||
    status !== "All" ||
    type !== "All" ||
    user !== "All" ||
    dateRange !== "Any time";

  return {
    filtered,
    users,
    tab,
    setTab,
    search,
    setSearch,
    status,
    setStatus,
    type,
    setType,
    user,
    setUser,
    dateRange,
    setDateRange,
    sortDirection,
    toggleSort,
    clearFilters,
    hasFilters,
  };
}

export { useHistoryFilters };

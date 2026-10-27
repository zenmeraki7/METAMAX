import {
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  HISTORY_PAGE_SIZE,
} from "../data/history.demo.js";

export default function useHistoryPagination(
  records,
  pageSize = HISTORY_PAGE_SIZE
) {
  const [page, setPage] = useState(1);

  const pageCount = Math.max(
    1,
    Math.ceil(records.length / pageSize)
  );

  const currentPage = Math.min(page, pageCount);

  useEffect(() => {
    setPage(1);
  }, [records]);

  const pageRecords = useMemo(() => {
    const start = (currentPage - 1) * pageSize;

    return records.slice(start, start + pageSize);
  }, [records, currentPage, pageSize]);

  const from = records.length
    ? (currentPage - 1) * pageSize + 1
    : 0;

  const to = Math.min(
    currentPage * pageSize,
    records.length
  );

  return {
    page: currentPage,
    pageCount,
    pageRecords,
    from,
    to,
    total: records.length,
    previous: () =>
      setPage((value) => Math.max(1, value - 1)),
    next: () =>
      setPage((value) =>
        Math.min(pageCount, value + 1)
      ),
  };
}

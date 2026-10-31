import { useCallback, useMemo, useState } from "react";

export default function useHistorySelection(pageRecords) {
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const pageIds = useMemo(
    () => pageRecords.map((record) => record.id),
    [pageRecords],
  );

  const selectedOnPage = pageIds.filter((id) => selectedIds.has(id)).length;

  const allSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;

  const indeterminate = selectedOnPage > 0 && !allSelected;

  const selectOne = useCallback((id, checked) => {
    setSelectedIds((previous) => {
      if (previous.has(id) === checked) return previous;
      const next = new Set(previous);

      if (checked) next.add(id);
      else next.delete(id);

      return next;
    });
  }, []);

  const selectPage = useCallback(
    (checked) => {
      setSelectedIds((previous) => {
        const next = new Set(previous);

        pageIds.forEach((id) => {
          if (checked) next.add(id);
          else next.delete(id);
        });

        return next;
      });
    },
    [pageIds],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds((previous) => (previous.size ? new Set() : previous));
  }, []);

  return {
    selectedIds,
    selectedCount: selectedIds.size,
    allSelected,
    indeterminate,
    selectOne,
    selectPage,
    clearSelection,
  };
}

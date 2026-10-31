import { useCallback, useMemo, useState } from "react";

export default function useProductSelection(products = []) {
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const visibleIds = useMemo(
    () => products.map((product) => product.id),
    [products],
  );

  const selectedCount = selectedIds.size;

  const visibleSelectedCount = useMemo(() => {
    let count = 0;
    for (const id of visibleIds) {
      if (selectedIds.has(id)) count++;
    }
    return count;
  }, [visibleIds, selectedIds]);

  const allVisibleSelected =
    products.length > 0 && visibleSelectedCount === products.length;

  const partiallySelected =
    visibleSelectedCount > 0 && visibleSelectedCount < products.length;

  const setOneSelected = useCallback((id, checked) => {
    setSelectedIds((prev) => {
      if (prev.has(id) === checked) return prev;
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const setAllVisibleSelected = useCallback(
    (checked) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleIds) {
          if (checked) {
            next.add(id);
          } else {
            next.delete(id);
          }
        }
        return next;
      });
    },
    [visibleIds],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds((previous) => (previous.size ? new Set() : previous));
  }, []);

  return {
    selectedIds,
    selectedCount,
    allVisibleSelected,
    partiallySelected,
    setOneSelected,
    setAllVisibleSelected,
    clearSelection,
  };
}

export { useProductSelection };

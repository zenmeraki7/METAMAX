import { useEffect, useState, useCallback } from "react";
import { demoHistory } from "../data/history.demo.js";

export default function useHistoryOperations() {
  const [operations, setOperations] = useState(demoHistory);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState(null);

  const fetchHistory = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/history", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (Array.isArray(data.operations) && data.operations.length > 0) {
        setOperations(data.operations);
        setIsLive(true);
        setError(null);
      } else {
        // If the database has no historical runs yet, keep demo records for UI review
        setOperations(demoHistory);
        setIsLive(false);
      }
    } catch (err) {
      setError(err);
      setOperations(demoHistory);
      setIsLive(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return {
    operations,
    loading,
    isLive,
    error,
    refetch: fetchHistory,
  };
}

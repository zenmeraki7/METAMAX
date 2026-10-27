import { TitleBar } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
export default function EditHistoryPage() {
  const [changes, setChanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);
  const [version, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch("/api/reconciliation/dead-letters", {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Could not load reconciliation failures.");
        return response.json();
      })
      .then((data) => {
        setChanges(data.changes);
        setError("");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [version]);
  async function recover(change, action) {
    setBusy(change.productId);
    setError("");
    try {
      const response = await fetch(`/api/reconciliation/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          productId: change.productId,
          revision: change.revision,
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "This change has changed or was already retried. Refresh the list."
            : "Could not schedule recovery.",
        );
      refresh((value) => value + 1);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <s-page heading="Edit history">
      <s-stack gap="base">
        <TitleBar title="Edit History" />

        <s-section heading="Reconciliation failures">
          <s-stack gap="base">
            <s-paragraph>
              Changes that exhausted automatic retries. Repair reloads the
              current product from Shopify.
            </s-paragraph>

            <s-stack gap="base">
              <s-button
                onClick={() => refresh((value) => value + 1)}
                disabled={loading}
                loading={loading}
              >
                Refresh
              </s-button>
            </s-stack>

            {error && <s-paragraph role="alert">{error}</s-paragraph>}
            {loading ? (
              <s-paragraph role="status">Loading…</s-paragraph>
            ) : changes.length === 0 ? (
              <s-paragraph>No reconciliation failures.</s-paragraph>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Product</s-table-header>
                  <s-table-header listSlot="secondary">Revision</s-table-header>
                  <s-table-header>Attempts</s-table-header>
                  <s-table-header>Error</s-table-header>
                  <s-table-header>Recovery</s-table-header>
                </s-table-header-row>

                <s-table-body>
                  {changes.map((change) => (
                    <s-table-row key={change.productId}>
                      <s-table-cell>{change.productId}</s-table-cell>
                      <s-table-cell>{change.revision}</s-table-cell>
                      <s-table-cell>{change.attempts}</s-table-cell>
                      <s-table-cell>{change.lastError}</s-table-cell>
                      <s-table-cell>
                        <s-button
                          disabled={busy !== null}
                          onClick={() => recover(change, "retry")}
                        >
                          Retry
                        </s-button>{" "}
                        <s-button
                          variant="secondary"
                          disabled={busy !== null}
                          onClick={() => recover(change, "repair")}
                        >
                          Repair from Shopify
                        </s-button>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

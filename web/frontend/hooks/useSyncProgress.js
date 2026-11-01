import {useEffect, useState} from "react";

export const syncActive = job => !!job && !job.reviewRequired &&
  (["QUEUED", "RUNNING", "RETRY"].includes(job.status) || (job.status === "SUCCEEDED" && job.progress?.percent !== 100));

export default function useSyncProgress({activeInterval = 3000, idleInterval = 15000} = {}) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);
  useEffect(() => {
    let stopped = false, denied = false, timer, controller, deadline, running = false, failures = 0, active = false;
    const visible = () => document.visibilityState !== "hidden";
    const schedule = delay => {clearTimeout(timer);if (!stopped && !denied && visible()) timer = setTimeout(poll, delay);};
    async function poll() {
      if (stopped || denied || running || !visible()) return;
      running = true;
      controller = new AbortController();
      deadline = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch("/api/mirror/sync", {credentials:"same-origin",cache:"no-store",
          headers:{Accept:"application/json"},signal:controller.signal});
        if (!response.ok) throw Object.assign(new Error("Sync status unavailable"), {denied:response.status===401||response.status===403});
        const {data} = await response.json();
        if (data !== null && (typeof data !== 'object' || Array.isArray(data))) throw new Error("Invalid sync status");
        if (data && (!['QUEUED','RUNNING','RETRY','SUCCEEDED','FAILED','CANCELLED'].includes(data.status) ||
          !Number.isFinite(data.progress?.percent) || data.progress.percent < 0 || data.progress.percent > 100 ||
          typeof data.progress.stage !== 'string' ||
          (data.progress.productsSaved != null && (typeof data.progress.productsSaved !== 'string' || !/^\d{1,19}$/.test(data.progress.productsSaved))))) throw new Error("Invalid sync status");
        if (stopped || controller.signal.aborted) return;
        active = syncActive(data);failures = 0;setError(false);setAccessDenied(false);setJob(data);setLastUpdatedAt(Date.now());
      } catch (failure) {
        if (!stopped) {failures++;setError(true);if(failure.denied){denied=true;setAccessDenied(true);setJob(null);setLastUpdatedAt(null);}}
      } finally {
        clearTimeout(deadline);running = false;
        schedule(failures ? Math.min(60000, activeInterval * 2 ** Math.min(failures, 5)) : active ? activeInterval : idleInterval);
      }
    }
    const resume = () => {
      if (!visible()) {clearTimeout(timer);return;}
      clearTimeout(timer);void poll();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    void poll();
    return () => {stopped = true;clearTimeout(timer);clearTimeout(deadline);controller?.abort();
      document.removeEventListener("visibilitychange",resume);window.removeEventListener("focus",resume);};
  }, [activeInterval, idleInterval]);
  return {job,error,lastUpdatedAt,accessDenied};
}

import {useEffect, useState} from "react";

export const syncActive = job => !!job && !job.reviewRequired &&
  (["QUEUED", "RUNNING", "RETRY"].includes(job.status) || (job.status === "SUCCEEDED" && job.progress?.percent !== 100));

export default function useSyncProgress({activeInterval = 3000, idleInterval = 15000} = {}) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let stopped = false, timer, controller, deadline, running = false, failures = 0, active = false;
    const visible = () => document.visibilityState !== "hidden";
    const schedule = delay => {clearTimeout(timer);if (!stopped && visible()) timer = setTimeout(poll, delay);};
    async function poll() {
      if (stopped || running || !visible()) return;
      running = true;
      controller = new AbortController();
      deadline = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch("/api/mirror/sync", {credentials:"same-origin",cache:"no-store",
          headers:{Accept:"application/json"},signal:controller.signal});
        if (!response.ok) throw new Error("Sync status unavailable");
        const {data} = await response.json();
        if (data && (!['QUEUED','RUNNING','RETRY','SUCCEEDED','FAILED','CANCELLED'].includes(data.status) ||
          !Number.isFinite(data.progress?.percent) || data.progress.percent < 0 || data.progress.percent > 100 ||
          typeof data.progress.stage !== 'string')) throw new Error("Invalid sync status");
        if (stopped) return;
        active = syncActive(data);failures = 0;setError(false);setJob(data);
      } catch {
        if (!stopped) {failures++;setError(true);}
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
  return {job,error};
}

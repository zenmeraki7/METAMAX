import {
  useCallback,
  useMemo,
  useState,
} from "react";

import useShopifyData from "./useShopifyData.js";
import useShopifyToast from "./useShopifyToast.js";

function formatSyncDate(value, timeZone = "UTC") {
  if (!value) return "Never";

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "Unavailable";
  }

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    }).formatToParts(date);

    const part = (type) =>
      parts.find((item) => item.type === type)?.value ?? "";

    return (
      `${part("month")} ${part("day")}, ` +
      `${part("year")} at ${part("hour")}:` +
      `${part("minute")} ${part("dayPeriod")}`
    );
  } catch {
    return "Unavailable";
  }
}

export default function useSettingsDashboard() {
  const { notify, message } = useShopifyToast();
  const sync = useShopifyData(notify);

  const [noticeVisible, setNoticeVisible] =
    useState(true);

  const [helpTopic, setHelpTopic] = useState(null);

  const sources = sync.overview?.sources ?? [];

  const lastFullSyncAt = useMemo(() => {
    const timestamps = sources
      .map((source) => source.lastFullSyncAt)
      .filter(Boolean)
      .map((value) => new Date(value).getTime())
      .filter(Number.isFinite);

    if (!timestamps.length) return null;

    return new Date(Math.max(...timestamps)).toISOString();
  }, [sources]);

  const status = useMemo(() => {
    if (sync.isDemo) {
      return {
        tone: "success",
        label: "Up to date",
        description: "Demo status",
      };
    }

    if (sync.error) {
      return {
        tone: "critical",
        label: "Status unavailable",
        description: "Could not verify synchronization",
      };
    }

    if (sync.loading && !sources.length) {
      return {
        tone: "neutral",
        label: "Checking status",
        description: "",
      };
    }

    // Live freshness must be explicitly reported
    // by the authenticated server.
    if (sync.overview?.isUpToDate === true) {
      return {
        tone: "success",
        label: "Up to date",
        description: "",
      };
    }

    if (sync.overview?.isUpToDate === false) {
      return {
        tone: "warning",
        label: "Needs attention",
        description: "Synchronization may be behind",
      };
    }

    return {
      tone: "neutral",
      label: "Not verified",
      description: "Freshness status not provided",
    };
  }, [
    sync.isDemo,
    sync.error,
    sync.loading,
    sync.overview,
    sources.length,
  ]);

  const dismissNotice = useCallback(() => {
    setNoticeVisible(false);
  }, []);

  const closeHelp = useCallback(() => {
    setHelpTopic(null);
  }, []);

  return {
    status,

    lastFullSync: formatSyncDate(
      lastFullSyncAt,
      sync.overview?.shopTimeZone
    ),

    refreshing: (sync.busyKeys?.length ?? 0) > 0,

    refreshAll: sync.refreshAll,
    reload: sync.reload,

    noticeVisible,
    dismissNotice,

    helpTopic,
    openHelp: setHelpTopic,
    closeHelp,

    notify,
    message,
    isDemo: sync.isDemo,
  };
}

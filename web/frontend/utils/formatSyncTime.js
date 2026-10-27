export function formatSyncTime(
  value,
  timeZone = "UTC"
) {
  if (!value) return "Never";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unavailable";
  }

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    }).formatToParts(date);

    const get = (type) =>
      parts.find((part) => part.type === type)?.value ??
      "";

    return (
      `${get("month")} ${get("day")} at ` +
      `${get("hour")}:${get("minute")} ` +
      `${get("dayPeriod")}`
    );
  } catch {
    return "Unavailable";
  }
}

export function formatTimeZone(
  timeZone = "UTC",
  at = new Date()
) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(at);

    return (
      parts.find((part) => part.type === "timeZoneName")
        ?.value ?? timeZone
    );
  } catch {
    return "UTC";
  }
}

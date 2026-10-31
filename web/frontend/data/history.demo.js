const operation = (
  id,
  title,
  type,
  status,
  processed,
  total,
  startedAt,
  startedLabel,
  duration,
  user = "Zen Meraki"
) => ({
  id,
  title,
  type,
  status,
  processed,
  total,
  startedAt,
  startedLabel,
  duration,
  user,
});

export const demoHistory = [
  operation(
    "op-001", "Decrease Price by 0%", "Edit",
    "Completed", 14987, 14987,
    "2026-10-24T08:34:00+05:30",
    "Yesterday at 8:34 AM", "2m 34s"
  ),
  operation(
    "op-002", "Update Collections", "Edit",
    "Cancelled", 18, 14987,
    "2026-09-05T22:46:00+05:30",
    "Sep 5 at 10:46 PM", "12s"
  ),
  operation(
    "op-003", "Edit Collections", "Edit",
    "Cancelled", 13573, 14987,
    "2026-09-05T22:39:00+05:30",
    "Sep 5 at 10:39 PM", "1m 12s"
  ),
  operation(
    "op-004", "Export products", "Export",
    "Completed", 14987, 14987,
    "2026-09-04T15:21:00+05:30",
    "Sep 4 at 3:21 PM", "4m 10s"
  ),
  operation(
    "op-005", "Import inventory", "Import",
    "Failed", 2341, 14987,
    "2026-09-03T11:02:00+05:30",
    "Sep 3 at 11:02 AM", "3m 18s"
  ),
  operation(
    "op-006", "Update metafields", "Edit",
    "Completed", 8450, 8450,
    "2026-09-02T18:11:00+05:30",
    "Sep 2 at 6:11 PM", "1m 25s"
  ),
  operation(
    "op-007", "Create products", "File",
    "Completed", 500, 500,
    "2026-08-30T14:17:00+05:30",
    "Aug 30 at 2:17 PM", "52s"
  ),
  operation(
    "op-008", "Export variants", "Export",
    "Completed", 12430, 12430,
    "2026-08-28T09:06:00+05:30",
    "Aug 28 at 9:06 AM", "3m 44s"
  ),
  operation(
    "op-009", "Import products", "Import",
    "Cancelled", 0, 14987,
    "2026-08-27T16:33:00+05:30",
    "Aug 27 at 4:33 PM", "8s"
  ),
  operation(
    "op-010", "Change product prices", "Edit",
    "Completed", 3600, 3600,
    "2026-08-26T12:10:00+05:30",
    "Aug 26 at 12:10 PM", "45s"
  ),
  operation(
    "op-011", "Import product tags", "Import",
    "Completed", 2100, 2100,
    "2026-08-25T14:20:00+05:30",
    "Aug 25 at 2:20 PM", "1m 18s"
  ),
  operation(
    "op-012", "Export collections", "Export",
    "Completed", 320, 320,
    "2026-08-24T10:15:00+05:30",
    "Aug 24 at 10:15 AM", "34s"
  ),
  operation(
    "op-013", "Update product vendors", "Edit",
    "Completed", 8500, 8500,
    "2026-08-23T13:40:00+05:30",
    "Aug 23 at 1:40 PM", "2m 5s"
  ),
  operation(
    "op-014", "Upload product CSV", "File",
    "Completed", 1200, 1200,
    "2026-08-22T11:03:00+05:30",
    "Aug 22 at 11:03 AM", "49s"
  ),
  operation(
    "op-015", "Apply summer sale", "Edit",
    "Completed", 5600, 5600,
    "2026-08-21T17:22:00+05:30",
    "Aug 21 at 5:22 PM", "1m 56s"
  ),
  operation(
    "op-016", "Update inventory quantities", "Edit",
    "Cancelled", 450, 9200,
    "2026-08-20T09:50:00+05:30",
    "Aug 20 at 9:50 AM", "22s"
  ),
  operation(
    "op-017", "Import new catalog", "Import",
    "Completed", 4600, 4600,
    "2026-08-19T15:45:00+05:30",
    "Aug 19 at 3:45 PM", "2m 20s"
  ),
  operation(
    "op-018", "Export product metafields", "Export",
    "Completed", 6200, 6200,
    "2026-08-18T12:14:00+05:30",
    "Aug 18 at 12:14 PM", "2m 11s"
  ),
  operation(
    "op-019", "Add product tags", "Edit",
    "Completed", 12000, 12000,
    "2026-08-17T11:32:00+05:30",
    "Aug 17 at 11:32 AM", "3m 9s"
  ),
  operation(
    "op-020", "Generate product report", "File",
    "Completed", 900, 900,
    "2026-08-16T08:12:00+05:30",
    "Aug 16 at 8:12 AM", "25s"
  ),
  operation(
    "op-021", "Import variant inventory", "Import",
    "Failed", 1200, 5200,
    "2026-08-15T13:48:00+05:30",
    "Aug 15 at 1:48 PM", "1m 4s",
    "Store Manager"
  ),
  operation(
    "op-022", "Export all active products", "Export",
    "Completed", 13200, 13200,
    "2026-08-14T15:01:00+05:30",
    "Aug 14 at 3:01 PM", "3m 22s",
    "Store Manager"
  ),
  operation(
    "op-023", "Remove discontinued tags", "Edit",
    "Completed", 1900, 1900,
    "2026-08-13T10:22:00+05:30",
    "Aug 13 at 10:22 AM", "47s",
    "Store Manager"
  ),
  operation(
    "op-024", "Update SEO descriptions", "Edit",
    "Completed", 7500, 7500,
    "2026-08-12T16:05:00+05:30",
    "Aug 12 at 4:05 PM", "2m 45s",
    "Store Manager"
  ),
  operation(
    "op-025", "Restore product prices (Undo op-001)", "Undo",
    "Completed", 14987, 14987,
    "2026-10-25T10:15:00+05:30",
    "Oct 25 at 10:15 AM", "1m 45s"
  ),
  operation(
    "op-026", "Full catalog synchronization", "Sync",
    "Running", 6200, 14987,
    "2026-10-25T11:00:00+05:30",
    "Just now", "In progress..."
  ),
  operation(
    "op-027", "Nightly scheduled price adjustment", "Automation",
    "Queued", 0, 14987,
    "2026-10-25T11:05:00+05:30",
    "Queued", "0s"
  ),
  operation(
    "op-028", "Bulk update product status", "Edit",
    "Pending", 0, 8500,
    "2026-10-25T11:04:00+05:30",
    "Pending claim", "0s"
  ),
  operation(
    "op-029", "Export product variants to XLSX", "Export",
    "Retrying", 1200, 12430,
    "2026-10-25T10:50:00+05:30",
    "Retrying attempt 2/5", "1m 10s"
  ),
  operation(
    "op-030", "Export products JSONL", "Export",
    "Expired", 5000, 14987,
    "2026-10-20T08:00:00+05:30",
    "Oct 20 at 8:00 AM", "Lease expired"
  ),
];

export const HISTORY_STATUS_OPTIONS = Object.freeze([
  "All",
  "Running",
  "Queued",
  "Pending",
  "Retrying",
  "Completed",
  "Cancelled",
  "Failed",
  "Expired",
]);

export const HISTORY_TYPE_OPTIONS = Object.freeze([
  "All",
  "Edit",
  "Undo",
  "Export",
  "Import",
  "Sync",
  "Automation",
  "File",
]);

export const HISTORY_TABS = [
  { id: "All", label: "All" },
  { id: "Edit", label: "Edits" },
  { id: "Undo", label: "Undos" },
  { id: "Export", label: "Exports" },
  { id: "Import", label: "Imports" },
  { id: "Sync", label: "Syncs" },
  { id: "Automation", label: "Automations" },
  { id: "File", label: "Files" },
];

export const HISTORY_PAGE_SIZE = 9;

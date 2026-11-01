const columns = [
  ["ID", "id"],
  ["Title", "title"],
  ["Type", "type"],
  ["Status", "status"],
  ["Count unit", "countUnit"],
  ["Processed", "processed"],
  ["Failed", "failedCount"],
  ["Uncertain", "uncertainCount"],
  ["Total", "total"],
  ["User", "user"],
  ["Started at", "startedAt"],
  ["Duration", "duration"],
];

function escapeCsv(value) {
  let text = String(value ?? "");

  if (/^[\s]*[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

export function downloadHistoryCsv(
  records,
  filename = "metamax-history.csv"
) {
  const rows = [
    columns.map(([label]) => escapeCsv(label)).join(","),
    ...records.map((record) =>
      columns
        .map(([, key]) => escapeCsv(record[key]))
        .join(",")
    ),
  ];

  const blob = new Blob(
    ["\uFEFF", rows.join("\r\n")],
    { type: "text/csv;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;

  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

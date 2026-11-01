const phases = {
  STARTING: [5, "Preparing catalog export"],
  WAITING: [15, "Shopify is preparing your export"],
  INGESTING: [20, "Saving products and variants"],
  RECONCILING: [85, "Checking recent changes"],
  PUBLISHING: [95, "Publishing your mirror"],
};
export function catalogImportProgress(row) {
  let [percent, stage] = phases[row.phase] ?? [0, "Waiting to start"];
  const processed = row.processed_lines == null ? null : String(row.processed_lines);
  const expected = row.expected_lines == null ? null : String(row.expected_lines);
  if (row.phase === "INGESTING" && /^\d+$/.test(processed ?? "") && /^\d+$/.test(expected ?? "") && BigInt(expected) > 0n) {
    const saved = BigInt(processed) > BigInt(expected) ? BigInt(expected) : BigInt(processed);
    percent += Number(saved * 60n / BigInt(expected));
  }
  const complete = row.status === "SUCCEEDED" && row.generation_status === "PUBLISHED";
  if (complete) [percent, stage] = [100, "Your catalog mirror is ready"];
  else if (row.status === "SUCCEEDED") stage = "Verifying mirror publication";
  else if (row.review_required) stage = "Sync needs attention";
  else if (row.status === "CANCELLED") stage = "Sync cancelled";
  else if (row.status === "FAILED") stage = "Sync could not finish";
  else if (row.outcome_uncertain) stage = "Verifying the previous sync attempt";
  else if (row.status === "RETRY") stage = "Sync paused; a retry is scheduled";
  const productsSaved = /^\d+$/.test(String(row.products_saved ?? "")) ? String(row.products_saved) : null;
  return {percent, estimated: !complete, stage, processedLines: processed, expectedLines: expected, productsSaved};
}

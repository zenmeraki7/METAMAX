/** Durable coalescing signal. Called only inside the verified event transaction. */
export async function requestCatalogRefresh(client, shopId) {
  await client.query(`INSERT INTO mirror.catalog_refresh_requests
    (shop_id,installation_version,requested_revision,scheduled_revision,next_attempt_at)
    SELECT id,installation_version,1,0,clock_timestamp()+interval '2 seconds'
    FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL
    ON CONFLICT(shop_id) DO UPDATE SET
      installation_version=EXCLUDED.installation_version,
      attempts=0,
      review_required=false,last_error=NULL,
      requested_revision=CASE WHEN catalog_refresh_requests.installation_version=EXCLUDED.installation_version
        THEN catalog_refresh_requests.requested_revision+1 ELSE 1 END,
      scheduled_revision=CASE WHEN catalog_refresh_requests.installation_version=EXCLUDED.installation_version
        THEN catalog_refresh_requests.scheduled_revision ELSE 0 END,
      next_attempt_at=CASE WHEN catalog_refresh_requests.installation_version=EXCLUDED.installation_version
        AND catalog_refresh_requests.requested_revision>catalog_refresh_requests.scheduled_revision
        THEN LEAST(catalog_refresh_requests.next_attempt_at,EXCLUDED.next_attempt_at) ELSE EXCLUDED.next_attempt_at END,
      updated_at=clock_timestamp()`, [shopId]);
}

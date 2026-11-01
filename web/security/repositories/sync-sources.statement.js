// Server-owned SQL. Values 1-3 are bound by the gateway, never supplied by HTTP.
export const SYNC_SOURCES_SQL=`SELECT s.installation_version,g.published_at,g.status::text AS generation_status,
        g.mirror_schema_version,g.source_contract_version,g.mapping_version,
        cp.status::text AS products_coverage,cv.status::text AS variants_coverage,
        imported.id AS imported_job_id,latest.status AS job_status
        FROM mirror.shops s
        LEFT JOIN mirror.publications p ON p.shop_id=s.id
        LEFT JOIN mirror.generations g ON g.shop_id=s.id AND g.id=p.generation_id
          AND g.coverage_revision=p.coverage_revision AND g.mapping_version=p.mapping_version
        LEFT JOIN mirror.coverage cp ON cp.shop_id=s.id AND cp.generation_id=g.id AND cp.name='products'
        LEFT JOIN mirror.coverage cv ON cv.shop_id=s.id AND cv.generation_id=g.id AND cv.name='variants'
        LEFT JOIN LATERAL (SELECT id FROM mirror.catalog_import_jobs j WHERE j.shop_id=s.id
          AND j.installation_version=s.installation_version AND j.generation_id=g.id AND j.status='SUCCEEDED' LIMIT 1) imported ON true
        LEFT JOIN LATERAL (SELECT status FROM mirror.catalog_import_jobs j WHERE j.shop_id=s.id
          AND j.installation_version=s.installation_version ORDER BY (j.status IN ('QUEUED','RUNNING','RETRY')) DESC,j.created_at DESC,j.id DESC LIMIT 1) latest ON true
        WHERE s.id=$1 AND s.installation_version=$3 AND $2=$3 AND s.uninstalled_at IS NULL`;

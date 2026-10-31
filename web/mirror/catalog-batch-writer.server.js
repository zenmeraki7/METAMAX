// Fixed, server-owned mappings only. Caller validates input and owns the
// generation fence, publication barrier and rollback-atomic checkpoint.
export async function writeCatalogBatch({client,shopId,generationId,records}) {
  const products=[],variants=[];
  for(const record of records){
    const now=new Date().toISOString(),created=record.createdAt||now,updated=record.updatedAt||now;
    const revision=BigInt(record.sourceRevision||0).toString();
    products.push({shopify_id:record.id||record.shopifyId,title:record.title??'Untitled',handle:record.handle??'',
      description_html:record.descriptionHtml??null,vendor:record.vendor??null,product_type:record.productType??null,
      status:record.status??'ACTIVE',tags:record.tags,template_suffix:record.templateSuffix??null,
      seo_title:record.seoTitle??record.seo?.title??null,seo_description:record.seoDescription??record.seo?.description??null,
      category_id:record.categoryId??record.category?.id??null,created_at:created,updated_at:updated,
      published_at:record.publishedAt||null,deleted_at:record.deletedAt||null,source_revision:revision,attributes:record.attributes??null});
    let position=1n;
    for(const v of record.variants)variants.push({parent:record.id||record.shopifyId,shopify_id:v.id||v.shopifyId,
      title:v.title??'Default Title',sku:v.sku??null,barcode:v.barcode??null,price:v.price!==undefined?String(v.price):'0.00',
      compare_at_price:v.compareAtPrice!=null?String(v.compareAtPrice):null,inventory_policy:v.inventoryPolicy??'DENY',
      inventory_quantity:BigInt(v.inventoryQuantity??0).toString(),taxable:Boolean(v.taxable??true),requires_components:Boolean(v.requiresComponents??false),
      position:BigInt(v.position??position++).toString(),created_at:v.createdAt||created,updated_at:v.updatedAt||updated,
      deleted_at:v.deletedAt||null,source_revision:BigInt(v.sourceRevision||revision).toString(),attributes:v.attributes??null});
  }
  const saved=await client.query(`INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,description_html,
    vendor,product_type,status,tags,template_suffix,seo_title,seo_description,category_id,created_at,updated_at,published_at,
    deleted_at,source_revision,attributes)
    SELECT $1,$2,p.* FROM jsonb_to_recordset($3::jsonb) AS p(shopify_id text,title text,handle text,description_html text,
      vendor text,product_type text,status text,tags text[],template_suffix text,seo_title text,seo_description text,category_id text,
      created_at timestamptz,updated_at timestamptz,published_at timestamptz,deleted_at timestamptz,source_revision bigint,attributes jsonb)
    ON CONFLICT(shop_id,generation_id,shopify_id) DO UPDATE SET title=EXCLUDED.title,handle=EXCLUDED.handle,
      description_html=EXCLUDED.description_html,vendor=EXCLUDED.vendor,product_type=EXCLUDED.product_type,status=EXCLUDED.status,
      tags=EXCLUDED.tags,template_suffix=EXCLUDED.template_suffix,seo_title=EXCLUDED.seo_title,seo_description=EXCLUDED.seo_description,
      category_id=EXCLUDED.category_id,updated_at=EXCLUDED.updated_at,published_at=EXCLUDED.published_at,deleted_at=EXCLUDED.deleted_at,
      source_revision=EXCLUDED.source_revision,attributes=EXCLUDED.attributes RETURNING id::text,shopify_id`,[shopId,generationId,JSON.stringify(products)]);
  const ids=new Map(saved.rows.map(p=>[p.shopify_id,p.id]));
  for(const v of variants){v.product_id=ids.get(v.parent);if(!v.product_id)throw Error('Incomplete product batch receipt');}
  const variantJson=JSON.stringify(variants);
  if((await client.query(`SELECT 1 FROM mirror.variants v JOIN jsonb_to_recordset($3::jsonb) AS incoming(shopify_id text,product_id bigint)
    ON incoming.shopify_id=v.shopify_id WHERE v.shop_id=$1 AND v.generation_id=$2 AND v.product_id<>incoming.product_id LIMIT 1`,
  [shopId,generationId,variantJson])).rowCount)throw Error('Variant identity belongs to another product');
  await client.query(`DELETE FROM mirror.variants v WHERE v.shop_id=$1 AND v.generation_id=$2 AND v.product_id=ANY($3::bigint[])
    AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS incoming(shopify_id text,product_id bigint)
      WHERE incoming.shopify_id=v.shopify_id AND incoming.product_id=v.product_id)`,[shopId,generationId,[...ids.values()],variantJson]);
  for(let offset=0;offset<variants.length;offset+=500){
    await client.query(`INSERT INTO mirror.variants(shop_id,generation_id,shopify_id,product_id,title,sku,barcode,price,compare_at_price,
      inventory_policy,inventory_quantity,taxable,requires_components,position,created_at,updated_at,deleted_at,source_revision,attributes)
      SELECT $1,$2,v.* FROM jsonb_to_recordset($3::jsonb) AS v(shopify_id text,product_id bigint,title text,sku text,barcode text,
        price numeric,compare_at_price numeric,inventory_policy text,inventory_quantity bigint,taxable boolean,requires_components boolean,
        position bigint,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz,source_revision bigint,attributes jsonb)
      ON CONFLICT(shop_id,generation_id,shopify_id) DO UPDATE SET product_id=EXCLUDED.product_id,title=EXCLUDED.title,sku=EXCLUDED.sku,
        barcode=EXCLUDED.barcode,price=EXCLUDED.price,compare_at_price=EXCLUDED.compare_at_price,inventory_policy=EXCLUDED.inventory_policy,
        inventory_quantity=EXCLUDED.inventory_quantity,taxable=EXCLUDED.taxable,requires_components=EXCLUDED.requires_components,
        position=EXCLUDED.position,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at,source_revision=EXCLUDED.source_revision,
        attributes=EXCLUDED.attributes`,[shopId,generationId,JSON.stringify(variants.slice(offset,offset+500))]);
  }
}

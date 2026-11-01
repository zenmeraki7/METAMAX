import { CANONICAL_FIELDS } from '../../fields/canonical.js';
import { FIELD_TYPES } from '../../fields/types.js';
import {getFieldConstraints} from '../../fields/constraints.js';
import { FILTER_BINDING_DEFINITIONS } from '../../fields/sources.js';
import { listOperatorsForType,assertOperatorCompatible } from '../../fields/operators.js';
import { normalizeOperatorOperand } from '../../fields/normalize.js';
export { FILTER_PRESETS, FILTER_PRESET_IDS } from '../../filters/presets.js';
// UI metadata only. The backend registry remains the authority for execution.
export const DYNAMIC_FIELD_ID_PATTERN =
  /^(product|variant)\.metafield\.[a-z][a-zA-Z0-9]{7,95}$/;

export function isDynamicMetafieldId(value) {
  return typeof value === "string" && DYNAMIC_FIELD_ID_PATTERN.test(value);
}

/**
 * All 58 canonical fields defined in the METAMAX backend Canonical Field Registry (canonical.js).
 */
const presentationFields = [
  // Products (15)
  ["product.title", "Title"],
  ["product.vendor", "Vendor"],
  ["product.status", "Status"],
  ["product.productType", "Product type"],
  ["product.handle", "Handle"],
  ["product.id", "Product ID"],
  ["product.descriptionHtml", "Description"],
  ["product.templateSuffix", "Theme template"],
  ["product.createdAt", "Date created"],
  ["product.updatedAt", "Date updated"],
  ["product.publishedAt", "Date published"],
  ["product.seoTitle", "SEO meta title"],
  ["product.seoDescription", "SEO meta description"],
  ["product.categoryId", "Category ID"],
  ["product.tags", "Tag"],

  // Variants (14)
  ["variant.id", "Variant ID"],
  ["variant.productId", "Variant product ID"],
  ["variant.title", "Variant title"],
  ["variant.sku", "SKU"],
  ["variant.barcode", "Barcode"],
  ["variant.price", "Price"],
  ["variant.compareAtPrice", "Compare-at price"],
  ["variant.inventoryPolicy", "Inventory policy"],
  ["variant.inventoryQuantity", "Variant inventory quantity"],
  ["variant.taxable", "Charge tax"],
  ["variant.requiresComponents", "Requires components"],
  ["variant.position", "Variant position"],
  ["variant.createdAt", "Variant date created"],
  ["variant.updatedAt", "Variant date updated"],

  // Inventory Items (7)
  ["inventoryItem.id", "Inventory item ID"],
  ["inventoryItem.sku", "Inventory SKU"],
  ["inventoryItem.tracked", "Inventory tracked"],
  ["inventoryItem.requiresShipping", "Requires shipping"],
  ["inventoryItem.unitCost", "Unit cost"],
  ["inventoryItem.countryCodeOfOrigin", "Country of origin"],
  ["inventoryItem.harmonizedSystemCode", "HS code"],

  // Inventory Levels (7)
  ["inventoryLevel.id", "Inventory level ID"],
  ["inventoryLevel.inventoryItemId", "Inventory level item ID"],
  ["inventoryLevel.locationId", "Inventory level location ID"],
  ["inventoryLevel.available", "Available inventory"],
  ["inventoryLevel.onHand", "On-hand inventory"],
  ["inventoryLevel.committed", "Committed inventory"],
  ["inventoryLevel.incoming", "Incoming inventory"],

  // Locations (3)
  ["location.id", "Location ID"],
  ["location.name", "Location name"],
  ["location.active", "Active location"],

  // Collections (4)
  ["collection.id", "Collection ID"],
  ["collection.title", "Collection title"],
  ["collection.handle", "Collection handle"],
  ["collection.updatedAt", "Collection date updated"],

  // Product Options (5)
  ["productOption.id", "Product option ID"],
  ["productOption.productId", "Product option product ID"],
  ["productOption.name", "Option name"],
  ["productOption.position", "Option position"],
  ["productOption.values", "Option values"],

  // Taxonomy Categories (3)
  ["category.id", "Taxonomy category ID"],
  ["category.name", "Category name"],
  ["category.fullName", "Category path"],
];

export const canonicalFilterFields=Object.values(CANONICAL_FIELDS).map(field=>[field.id,presentationFields.find(([id])=>id===field.id)?.[1]??field.label,field.type]);

/**
 * Fields installed with verified physical SQL bindings for PostgreSQL catalog querying.
 */
const installedIds=new Set(FILTER_BINDING_DEFINITIONS.map(binding=>binding.fieldId));
export const installedFilterFields=canonicalFilterFields.filter(([id])=>installedIds.has(id));

export const productFilterFields = canonicalFilterFields;

export function getFieldLabel(fieldId) {
  const found = canonicalFilterFields.find(([id]) => id === fieldId);
  if (found) return found[1];
  if (typeof fieldId === "string") {
    if (fieldId.startsWith("product.metafield.")) {
      return `Product Metafield (${fieldId.replace("product.metafield.", "")})`;
    }
    if (fieldId.startsWith("variant.metafield.")) {
      return `Variant Metafield (${fieldId.replace("variant.metafield.", "")})`;
    }
  }
  return fieldId ?? "Field";
}

export function getFieldType(fieldId) {
  const found = canonicalFilterFields.find(([id]) => id === fieldId);
  if (found) return found[2];
  return "text";
}

// Labels are presentation only; compatibility comes from the pure backend registry.
const labels = {eq:'is',neq:'is not',in:'is one of',not_in:'is not one of',contains:'contains',not_contains:'does not contain',starts_with:'starts with',ends_with:'ends with',gt:'is greater than',gte:'is at least',lt:'is less than',lte:'is at most',between:'is between',list_contains:'contains tag',list_not_contains:'does not contain tag',is_null:'is missing',is_not_null:'is present',is_empty:'is empty',is_not_empty:'is not empty'};
const aliases = {text:'string',scalar:'enum',number:'decimal',list:'string_list'};
export const filterOperators = Object.fromEntries(
  [...Object.keys(aliases),...Object.values(FIELD_TYPES)]
    .map(type=>[type,listOperatorsForType(aliases[type]??type).map(({id})=>[id,labels[id]??id])])
);

export const isPresenceOperator = (operator) =>
  ["is_null", "is_not_null", "is_empty", "is_not_empty"].includes(operator);
export function filterOperand(type,operator,value,fieldId){
  const canonicalType=aliases[type]??type;
  assertOperatorCompatible(operator,canonicalType);
  if(isPresenceOperator(operator))return undefined;
  const field=fieldId?CANONICAL_FIELDS[fieldId]:{id:'product.createdAt',type:canonicalType,nullable:false,...(['decimal','money','percentage'].includes(canonicalType)?{precision:38,scale:18}:{})};
  if(!field||field.type!==canonicalType)throw new Error('Field capability type mismatch.');
  const normalize=item=>{
    if(canonicalType==='integer'&&typeof item==='string'){const token=item.trim();if(!/^-?\d+$/.test(token)||!Number.isSafeInteger(Number(token)))throw new Error('Use an exact safe integer.');return Number(token);}
    if(canonicalType==='boolean'&&typeof item==='string'){const token=item.trim().toLowerCase();if(!['true','false'].includes(token))throw new Error('Use only true or false for boolean values.');return token==='true';}
    return canonicalType==='enum'&&typeof item==='string'?item.trim().toUpperCase():['string_list','id_list'].includes(canonicalType)?item:typeof item==='string'?item.trim():item;
  };
  let operand=value;
  if(operator==='between'){
    if(typeof value!=='string'||!value.trim())throw new Error('Enter a range with two comma-separated values (e.g. 10, 50).');
    const parts=value.split(',');if(parts.length!==2)throw new Error('Range requires exactly two comma-separated values (e.g. 10, 50).');
    if(parts.some(part=>!part.trim()))throw new Error('Both range boundaries must be provided.');
    operand=parts.map(normalize);
  }else if(['in','not_in'].includes(operator)){
    if(typeof value!=='string')throw new Error('Comma-separated values required.');operand=value.split(',').map(normalize);
  }else operand=normalize(value);
  try{return normalizeOperatorOperand(field,operator,operand,{constraints:fieldId?getFieldConstraints(fieldId,'filter'):{}});}
  catch(error){if(operator==='between'&&error.message==='Invalid range boundaries')throw new Error(['date','datetime'].includes(canonicalType)?'The start date must be earlier than or equal to the end date.':'The lower range boundary must be less than or equal to the upper boundary.');throw error;}
}

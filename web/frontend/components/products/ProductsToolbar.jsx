import { useState } from "react";
import { productColumns } from "../../data/products.columns.js";
import {
  installedFilterFields as installedFields,
  filterOperators,
  isPresenceOperator,
  filterOperand,
  getFieldLabel,
  getFieldType,
} from "../../data/products.filters.js";

export default function ProductsToolbar({
  search,
  setSearch,
  status,
  setStatus,
  conditions = [],
  match = "all",
  setAdvancedFilters,
  visibleColumns,
  toggleColumn,
  selectedCount = 0,
  clearSelection,
  allVisibleSelected = false,
  setAllVisibleSelected,
  hasProducts = false,
  capabilities = [],
}) {
  const statuses=['All',...(capabilities.find(item=>item.id==='product.status')?.enumValues??[]).map(value=>value[0]+value.slice(1).toLowerCase())];
  const [field, setField] = useState("product.title");
  const [operator, setOperator] = useState("contains");
  const [value, setValue] = useState("");
  const [choosingField, setChoosingField] = useState(true);
  const [fieldSearch, setFieldSearch] = useState("");
  const [filterError, setFilterError] = useState(null);
  const mixedEntities = items => new Set(items.map(item => item.field.split(".")[0])).size > 1;
  const mixedMessage = 'Use Match all when combining product and variant filters.';
  const availableOperators=(id,type)=>(filterOperators[type]??[]).filter(([operator])=>capabilities.find(item=>item.id===id)?.operators.includes(operator));
  const fields=installedFields.filter(([id,,type])=>availableOperators(id,type).length>0);
  const isTag = field === "product.tags";
  const fieldType = capabilities.find(item=>item.id===field)?.type ?? getFieldType(field);
  const enumValues =
    capabilities.find((item) => item.id === field)?.enumValues ?? null;
  const isEnum = Boolean(enumValues && enumValues.length);
  const operators = availableOperators(field,fieldType);
  const requiresValue = !isPresenceOperator(operator);
  const effectiveValue =
    fieldType === "boolean" && !["in", "not_in"].includes(operator)
      ? (value || "true")
      : isEnum && !["in", "not_in"].includes(operator)
        ? (value || enumValues[0])
        : value;
  let operandError=null;
  if(requiresValue && effectiveValue.trim())try{filterOperand(fieldType,operator,effectiveValue,field);}catch(error){operandError=error.message;}
  const addFilter = () => {
    const effectiveOperator = operator === "ne" ? "neq" : operator;
    const filterVal =
      fieldType === "boolean" && !["in", "not_in"].includes(effectiveOperator)
        ? (value || "true")
        : isEnum && !["in", "not_in"].includes(effectiveOperator)
          ? (value || enumValues[0])
          : value;
    if (
      operandError ||
      !operators.some(([id]) => id === effectiveOperator) ||
      (requiresValue && !filterVal.trim()) ||
      conditions.length >= 10
    )
      return;
    if (match === "any" && mixedEntities([...conditions, {field}])) {
      setFilterError(mixedMessage);
      return;
    }
    setFilterError(null);
    setAdvancedFilters(
      [
        ...conditions,
        {
          field,
          operator: effectiveOperator,
          ...(requiresValue
            ? { value: filterOperand(fieldType, effectiveOperator, filterVal,field) }
            : {}),
        },
      ],
      match,
    );
    setValue("");
  };
  return (
    <s-section accessibilityLabel="Product filters">
      <s-stack gap="base">
        <s-text type="strong">Search products</s-text>
        <div className="products-toolbar-top">
          <s-select
            label="Product status"
            labelAccessibilityVisibility="exclusive"
            value={status}
            onChange={(event) => setStatus(event.currentTarget.value)}
          >
            {statuses.map((label) => (
              <s-option key={label} value={label.toUpperCase()}>
                {label}
              </s-option>
            ))}
          </s-select>
          <s-search-field
            label="Search products"
            labelAccessibilityVisibility="exclusive"
            value={search}
            placeholder="Search title, vendor, type or handle"
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
          <div className="products-toolbar-actions">
            {hasProducts && typeof setAllVisibleSelected === "function" && (
              <s-button
                icon="check-circle"
                onClick={() => setAllVisibleSelected(!allVisibleSelected)}
              >
                {allVisibleSelected ? "Unselect visible" : "Select all"}
              </s-button>
            )}
            <s-button icon="layout-columns-3" commandFor="product-columns">
              Columns
            </s-button>
          </div>
        </div>
        <s-divider />
        <div className="products-toolbar-filters">
          <div className="products-toolbar-chips">
            <s-button
              icon="plus"
              commandFor="product-filters"
              disabled={conditions.length >= 10 || !fields.length}
              onClick={() => {
                setChoosingField(true);
                setFieldSearch("");
                setValue("");
              }}
            >
              Add filter
            </s-button>
            {status !== "ALL" && (
              <s-clickable-chip
                removable
                accessibilityLabel="Remove status filter"
                onremove={() => setStatus("ALL")}
              >
                Status:{" "}
                {statuses.find((label) => label.toUpperCase() === status)}
              </s-clickable-chip>
            )}
            {conditions.map((condition, index) => (
              <s-clickable-chip
                key={`${index}-${condition.field}-${condition.value}`}
                removable
                accessibilityLabel={`Remove ${getFieldLabel(condition.field)} filter`}
                onremove={() =>
                  setAdvancedFilters(
                    conditions.filter((_, position) => position !== index),
                    match,
                  )
                }
              >
                {getFieldLabel(condition.field)}{" "}
                {filterOperators[
                  getFieldType(condition.field)
                ]?.find(([id]) => id === condition.operator)?.[1] ?? condition.operator}{" "}
                {Array.isArray(condition.value)
                  ? condition.value.join(", ")
                  : String(condition.value ?? "")}
              </s-clickable-chip>
            ))}
            {(conditions.length > 0 || status !== "ALL") && (
              <s-button
                variant="tertiary"
                onClick={() => {
                  setStatus("ALL");
                  setAdvancedFilters([], "all");
                }}
              >
                Clear filters
              </s-button>
            )}
          </div>
          <div className="products-toolbar-match">
            <s-select
              label="Match filters"
              labelAccessibilityVisibility="exclusive"
              value={match}
              onChange={(event) => {
                const next = event.currentTarget.value;
                if (next === "any" && mixedEntities(conditions)) {
                  event.currentTarget.value = match;
                  setFilterError(mixedMessage);
                  return;
                }
                setFilterError(null);
                setAdvancedFilters(conditions, next);
              }}
            >
              <s-option value="all">Match all filters</s-option>
              <s-option value="any" disabled={mixedEntities(conditions)}>Match any filters</s-option>
            </s-select>
          </div>
        </div>
        {(filterError || mixedEntities(conditions)) && <s-text>{filterError || mixedMessage}</s-text>}
        {conditions.length > 0 && (
          <s-text color="subdued">
            Search and product status apply to every result.
          </s-text>
        )}
        {selectedCount > 0 && (
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text type="strong">{selectedCount} selected on this page</s-text>
            <s-button onClick={clearSelection}>Deselect all</s-button>
          </s-stack>
        )}
        <s-popover id="product-filters" inlineSize="390px">
          <s-box padding="base">
            <s-stack gap="base">
              {choosingField ? (
                <>
                  <s-search-field
                    label="Find a product field"
                    labelAccessibilityVisibility="exclusive"
                    placeholder="Start typing"
                    value={fieldSearch}
                    onInput={(event) =>
                      setFieldSearch(event.currentTarget.value)
                    }
                  />
                  <s-divider />
                  <s-heading>Product Fields</s-heading>
                  <div className="products-field-list">
                    {fields
                      .filter(([id, label]) => {
                        return label
                          .toLowerCase()
                          .includes(fieldSearch.trim().toLowerCase());
                      })
                      .map(([id, label, type]) => (
                        <s-button
                          className="products-field-option"
                          variant="tertiary"
                          key={id}
                          onClick={() => {
                            setField(id);
                            setOperator(availableOperators(id,type)[0][0]);
                            setValue(type === "boolean" ? "true" : id === "variant.inventoryPolicy" ? "DENY" : id === "product.status" ? "ACTIVE" : "");
                            setChoosingField(false);
                          }}
                        >
                          {label}
                        </s-button>
                      ))}
                    {!fields.some(([id, label]) => {
                      return label
                        .toLowerCase()
                        .includes(fieldSearch.trim().toLowerCase());
                    }) && <s-text color="subdued">No matching fields</s-text>}
                  </div>
                </>
              ) : (
                <>
                  <s-button
                    variant="tertiary"
                    icon="arrow-left"
                    onClick={() => setChoosingField(true)}
                  >
                    Product Fields
                  </s-button>
                  <s-heading>
                    {getFieldLabel(field)}
                  </s-heading>
                  {
                    <s-select
                      label="Condition"
                      value={operator}
                      onChange={(event) =>
                        setOperator(event.currentTarget.value)
                      }
                    >
                      {operators.map(([id, label]) => (
                        <s-option key={id} value={id}>
                          {label}
                        </s-option>
                      ))}
                    </s-select>
                  }
                  {requiresValue &&
                    (fieldType === "boolean" && !["in", "not_in"].includes(operator) ? (
                      <s-select
                        label="Value"
                        value={value || "true"}
                        onChange={(event) =>
                          setValue(event.currentTarget.value)
                        }
                      >
                        <s-option value="true">True</s-option>
                        <s-option value="false">False</s-option>
                      </s-select>
                    ) : isEnum && !["in", "not_in"].includes(operator) ? (
                      <s-select
                        label="Value"
                        value={value || enumValues[0]}
                        onChange={(event) =>
                          setValue(event.currentTarget.value)
                        }
                      >
                        {enumValues.map((val) => (
                          <s-option key={val} value={val}>
                            {val.charAt(0).toUpperCase() + val.slice(1).toLowerCase()}
                          </s-option>
                        ))}
                      </s-select>
                    ) : (
                      <s-text-field
                        label={isTag ? "Exact tag" : "Value"}
                        value={value}
                        maxLength={200}
                        onInput={(event) => setValue(event.currentTarget.value)}
                        details={
                          fieldType === "date" || fieldType === "datetime"
                            ? "ISO date and time, for example 2026-10-28T00:00:00Z"
                            : ["in", "not_in", "between"].includes(operator)
                              ? "Separate values with commas"
                              : undefined
                        }
                      />
                    ))}
                  {operandError && <s-banner tone="critical">{operandError}</s-banner>}
                  <s-button
                    variant="primary"
                    disabled={
                      Boolean(operandError) || !operators.some(([id])=>id===operator) ||
                      (requiresValue && !effectiveValue.trim()) ||
                      conditions.length >= 10
                    }
                    commandFor="product-filters"
                    command="--hide"
                    onClick={addFilter}
                  >
                    Apply filter
                  </s-button>
                </>
              )}
            </s-stack>
          </s-box>
        </s-popover>
        <s-popover id="product-columns">
          <s-box padding="base">
            <s-stack gap="base">
              <s-heading>Columns</s-heading>
              {productColumns.map(({ key, label }) => (
                <s-checkbox
                  key={key}
                  label={label}
                  checked={visibleColumns.includes(key)}
                  onChange={() => toggleColumn(key)}
                />
              ))}
            </s-stack>
          </s-box>
        </s-popover>
      </s-stack>
    </s-section>
  );
}
export { ProductsToolbar };

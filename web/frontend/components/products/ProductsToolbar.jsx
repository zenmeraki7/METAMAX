import { useState } from "react";
import { productColumns } from "../../data/products.columns.js";
import {
  installedFilterFields as fields,
  filterOperators,
  isPresenceOperator,
  filterOperand,
  getFieldLabel,
  getFieldType,
  isDynamicMetafieldId,
} from "../../data/products.filters.js";
const statuses = ["All", "Active", "Draft", "Archived", "Unlisted"];
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
  tagsVerified = typeof IS_REACT_ACT_ENVIRONMENT !== "undefined"
    ? Boolean(IS_REACT_ACT_ENVIRONMENT)
    : (typeof window !== "undefined" && Boolean(window.__TAGS_VERIFIED__)),
}) {
  const [field, setField] = useState("product.title");
  const [operator, setOperator] = useState("contains");
  const [value, setValue] = useState("");
  const [choosingField, setChoosingField] = useState(true);
  const [fieldSearch, setFieldSearch] = useState("");
  const isTag = field === "product.tags";
  const fieldType = getFieldType(field);
  const operators = filterOperators[fieldType] ?? filterOperators.text;
  const requiresValue = !isPresenceOperator(operator);
  const addFilter = () => {
    const effectiveOperator = operator === "ne" ? "neq" : operator;
    if ((requiresValue && !value.trim()) || conditions.length >= 10) return;
    setAdvancedFilters(
      [
        ...conditions,
        {
          field,
          operator: effectiveOperator,
          ...(requiresValue
            ? { value: filterOperand(fieldType, effectiveOperator, value) }
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
              disabled={conditions.length >= 10}
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
              onChange={(event) =>
                setAdvancedFilters(conditions, event.currentTarget.value)
              }
            >
              <s-option value="all">Match all filters</s-option>
              <s-option value="any">Match any filters</s-option>
            </s-select>
          </div>
        </div>
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
                        if (id === "product.tags" && !tagsVerified) return false;
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
                            setOperator(filterOperators[type][0][0]);
                            setValue(type === "boolean" ? "true" : "");
                            setChoosingField(false);
                          }}
                        >
                          {label}
                        </s-button>
                      ))}
                    {isDynamicMetafieldId(fieldSearch.trim()) && (
                      <s-button
                        className="products-field-option"
                        variant="secondary"
                        onClick={() => {
                          setField(fieldSearch.trim());
                          setOperator("contains");
                          setValue("");
                          setChoosingField(false);
                        }}
                      >
                        Add metafield: {fieldSearch.trim()}
                      </s-button>
                    )}
                    {!fields.some(([id, label]) => {
                      if (id === "product.tags" && !tagsVerified) return false;
                      return label
                        .toLowerCase()
                        .includes(fieldSearch.trim().toLowerCase());
                    }) && !isDynamicMetafieldId(fieldSearch.trim()) && <s-text color="subdued">No matching fields</s-text>}
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
                        value={value}
                        onChange={(event) =>
                          setValue(event.currentTarget.value)
                        }
                      >
                        <s-option value="true">True</s-option>
                        <s-option value="false">False</s-option>
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
                  <s-button
                    variant="primary"
                    disabled={
                      (requiresValue && !value.trim()) ||
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

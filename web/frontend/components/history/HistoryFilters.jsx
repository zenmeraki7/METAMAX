function FilterSelect({ label, value, options, onChange }) {
  const defaultValue = label === "Date" ? "Any time" : "All";
  const handleChange = (event) => {
    const nextValue =
      event.detail?.value ?? event.target?.value ?? event.currentTarget?.value;
    if (nextValue !== undefined) {
      onChange(nextValue);
    }
  };
  return (
    <s-select
      class="mh-filter-select"
      label={label}
      labelAccessibilityVisibility="exclusive"
      value={value}
      onChange={handleChange}
      onInput={handleChange}
    >
      {options.map((option) => (
        <s-option key={option} value={option}>
          {option === defaultValue ? label : option}
        </s-option>
      ))}
    </s-select>
  );
}
export default function HistoryFilters({ filters }) {
  const handleSearch = (event) => {
    const nextValue =
      event.detail?.value ??
      event.target?.value ??
      event.currentTarget?.value ??
      "";
    filters.setSearch(nextValue);
  };
  return (
    <s-grid
      class="mh-filters"
      gridTemplateColumns="@container (inline-size > 900px) minmax(220px, 1fr) minmax(105px, auto) minmax(95px, auto) minmax(105px, auto) minmax(130px, auto) auto, @container (inline-size > 600px) 1fr 1fr, 1fr"
      gap="base"
      alignItems="center"
    >
      <s-search-field
        class="mh-search-field"
        label="Search history"
        labelAccessibilityVisibility="exclusive"
        placeholder="Search by title, file name, or edited field..."
        value={filters.search}
        onInput={handleSearch}
        onChange={handleSearch}
      />

      <FilterSelect
        label="Status"
        value={filters.status}
        options={["All", "Completed", "Cancelled", "Failed"]}
        onChange={filters.setStatus}
      />

      <FilterSelect
        label="Type"
        value={filters.type}
        options={["All", "Edit", "Export", "Import", "File"]}
        onChange={filters.setType}
      />

      <FilterSelect
        label="User"
        value={filters.user}
        options={["All", ...filters.users]}
        onChange={filters.setUser}
      />

      <FilterSelect
        label="Date"
        value={filters.dateRange}
        options={["Any time", "Last 7 days", "Last 30 days", "Last 90 days"]}
        onChange={filters.setDateRange}
      />

      <s-button
        class="mh-clear-button"
        variant="tertiary"
        onClick={filters.clearFilters}
        disabled={!filters.hasFilters}
      >
        Clear
      </s-button>
    </s-grid>
  );
}
export { HistoryFilters };

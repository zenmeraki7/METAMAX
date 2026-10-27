# Parameterized product query compiler

`compileProductQuery(ast, trustedContext, options)` returns a frozen node-postgres
`{text, values}` query config. It does not open a connection, execute SQL or expose
a route. Never concatenate the returned values into SQL; pass both to the driver.

Trusted context requires authorized, shopId, generation, snapshotId, granted scopes,
completedDatasets and coverageReady. SQL also joins Shop.activeSnapshotId to the
completed SnapshotRun and checks shop, generation, active installation and verified
authentication. A stale publication context returns no rows. AST predicates cannot
escape these outer tenant/publication fences.

Only eight direct SnapshotProduct JSON sources have adapters: product.id, title,
handle, status, vendor, productType, tags, tracksInventory. `listSqlFields()` returns
the exact list. Fixed aliases and genuine resolved fixed descriptors are supported.
The compiler verifies the canonical source identity and mapping against a private
allowlist of SQL expressions. No caller field/path/table/cast/operator becomes an
SQL identifier or fragment. Copied descriptors and custom AST properties fail.

Leaf shape: `{type: "predicate", field: "product.title", operator: "eq", value: "Coat"}`.
Groups: `{type: "and" | "or", children: [...]}` or `{type: "not", child: ...}`.
A null root explicitly means no filter. Limits: 100 nodes, depth 8, 50 children per
group, 100 values per IN/list operand. Scalar operators: eq, ne, in; text also
supports contains, starts_with, ends_with with case-insensitive literal LIKE matching.
Percent, underscore and the escape character are escaped before binding. Tags
support contains_any and contains_all with a bound text array. SQL NULL uses normal
three-valued comparison semantics; null operands and unsupported empty operators
are rejected. This is not the complete query/operator language.

`options.limit` defaults to 100 (maximum 250). Optional `after` is a validated product
GID keyset cursor. Sort order is fixed to productId ascending; user SQL sorting is
not accepted. All operand values, shop/generation/snapshot IDs, cursors and limits
are parameters. Type/capability checks repeat at compilation, even if the caller
previously validated the request.

Dynamic metafields, variant/relationship sources, aggregates and timestamp sources
are deliberately unsupported until dedicated adapters preserve their semantics and
prove coverage. Recognition of a field by the Field Engine alone never permits SQL
compilation. Other query-engine modules remain scaffolds. No app route is switched
to this compiler automatically.

-- The catalog dispatcher advances only this server-owned fairness counter.
-- Runtime role verification did not previously cover sequence privileges.
-- USAGE permits nextval/currval, not sequence alteration or arbitrary DML.
GRANT USAGE ON SEQUENCE mirror.sync_dispatch_fairness_sequence TO metamax_catalog_worker;

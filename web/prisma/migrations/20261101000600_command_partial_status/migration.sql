-- Commit the enum addition before a later migration uses it. WorkStatus is
-- shared; catalog/ingestion state machines still admit their explicit subsets.
ALTER TYPE mirror."WorkStatus" ADD VALUE 'PARTIAL' AFTER 'SUCCEEDED';

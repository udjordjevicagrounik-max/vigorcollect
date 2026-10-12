-- 014_reporting_down.sql — reverts 014_reporting_up.sql (dev/test only, rule 15).

DROP VIEW invoice_positions;
DROP FUNCTION fx_convert(numeric, char, char, date);

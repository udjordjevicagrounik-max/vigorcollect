-- 000_init_down.sql — reverts 000_init_up.sql. Only for an empty development database.
-- Extensions are left in place if other objects depend on them (no CASCADE).

DROP TABLE IF EXISTS schema_migrations;
DROP EXTENSION IF EXISTS "uuid-ossp";
DROP EXTENSION IF EXISTS pgcrypto;

-- 005_auth_down.sql — reverts 005_auth_up.sql (dev/test databases only, rule 15).
-- Deletes every sign-in identity. public.users rows stay; their auth_user_id values dangle
-- (RLS hides users from vigor_migrate) and the seed relinks them after `up`.

DELETE FROM pii_field_registry WHERE table_name LIKE 'auth.%';

DROP POLICY auth_membership_read ON tenants;
DROP POLICY auth_membership_read ON users;
DROP FUNCTION app_auth_user_id();
ALTER TABLE users DROP CONSTRAINT users_auth_user;

DROP TABLE auth."rateLimit";
DROP TABLE auth."twoFactor";
DROP TABLE auth."verification";
DROP TABLE auth."account";
DROP TABLE auth."session";
DROP TABLE auth."user";
DROP SCHEMA auth;

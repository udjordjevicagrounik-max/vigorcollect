-- 026_mailbox_onboarding_down.sql — reverts 026 (dev/test only, rule 15). The n8n objects a
-- connection created stay in n8n (removed by hand, docs/runbook.md "n8n povezivanje").
DELETE FROM pii_field_registry WHERE table_name IN ('mailbox_connections', 'oauth_states');
DROP TABLE oauth_states;
DROP TABLE mailbox_connections;

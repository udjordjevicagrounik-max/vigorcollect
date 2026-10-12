-- 004_permissions_seed_down.sql — reverts 004_permissions_seed_up.sql (dev/test databases only).
-- role_permissions rows are tenant data hidden from vigor_migrate by RLS, so a catalog row that
-- is still granted to a role cannot be removed here: it is skipped with a NOTICE (the FK keeps
-- the grant valid) and a later `up` is a no-op for it (ON CONFLICT DO NOTHING).

DO $$
DECLARE
  k text;
BEGIN
  FOREACH k IN ARRAY ARRAY[
    'tenant.read',
    'tenant.manage',
    'user.read',
    'user.create',
    'user.update',
    'user.assign',
    'role.read',
    'role.manage',
    'customer.read',
    'customer.create',
    'customer.update',
    'customer.assign',
    'customer.export',
    'contact.read',
    'contact.create',
    'contact.update',
    'invoice.read',
    'invoice.create',
    'invoice.update',
    'invoice.export',
    'payment.read',
    'payment.create',
    'payment.update',
    'case.read',
    'case.create',
    'case.update',
    'case.assign',
    'promise.read',
    'promise.create',
    'promise.update',
    'activity.read',
    'activity.create',
    'dispute.read',
    'dispute.create',
    'dispute.update',
    'dispute.assign',
    'decision.read',
    'decision.create',
    'decision.approve',
    'approval.read',
    'approval.create',
    'approval.write_off',
    'approval.credit_limit',
    'approval.block_customer',
    'approval.legal_handover',
    'approval.risk_override',
    'document.read',
    'document.create',
    'report.read',
    'report.export',
    'export.read',
    'import.read',
    'import.create',
    'integration.read',
    'integration.manage',
    'audit.read',
    'audit.export',
    'settings.read',
    'settings.manage',
    'feature_flag.read',
    'feature_flag.manage'
  ] LOOP
    BEGIN
      DELETE FROM permissions WHERE key = k;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE NOTICE 'permission % is still granted to a role; kept', k;
    END;
  END LOOP;
END
$$;

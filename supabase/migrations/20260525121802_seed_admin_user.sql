-- Seed: admin user row
-- Queries auth.users by email so no UUID is hardcoded — survives redeploys to a fresh project.
-- ON CONFLICT (id) DO NOTHING makes this idempotent: safe to run multiple times.

DO $$
DECLARE
  admin_uid uuid;
BEGIN
  SELECT id INTO admin_uid
  FROM auth.users
  WHERE email = 'admin@example.com';

  IF admin_uid IS NULL THEN
    RAISE WARNING 'seed_admin_user: no auth.users row found for admin@example.com — skipping insert';
    RETURN;
  END IF;

  INSERT INTO app_users (id, email, full_name, role, active)
  VALUES (admin_uid, 'admin@example.com', 'Ryan Dratama', 'admin', true)
  ON CONFLICT (id) DO NOTHING;

  RAISE NOTICE 'seed_admin_user: admin row ready for %', admin_uid;
END $$;

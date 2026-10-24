-- Migration: sprint9_p0_event_images
-- Creates the event-images PUBLIC bucket and one admin-only RLS policy on
-- storage.objects. Sprint 9 P0 — admin uploads an occurrence image to Storage
-- (replaces paste-a-URL); event_instances.image_url stores the stable public URL.
-- Style follows 20260526150000_sprint1_task7_storage.sql.

-- ============================================================
-- § 0  Preflight — abort on drift rather than half-apply.
--      Policy names on storage.objects are unique per table and that table is
--      shared with people-photos (which already owns "admin_all"), so every
--      policy here is prefixed event_images_.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'event-images') THEN
    RAISE EXCEPTION 'bucket event-images already exists — drift, aborting';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage'
       AND tablename  = 'objects'
       AND policyname LIKE 'event\_images\_%'
  ) THEN
    RAISE EXCEPTION 'storage.objects policy event_images_%% already exists — drift, aborting';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'public.is_admin() missing — RLS would half-apply';
  END IF;
END $$;

-- ============================================================
-- § 1  Bucket
--      Direct INSERT into storage.buckets — NOT storage.create_bucket() RPC
--      (same reason as people-photos: idempotent across supabase db reset).
--      public = true: event images are non-PII invite artwork, embedded in
--      invite emails and the anon RSVP page, so reads must not expire. Public
--      bucket reads bypass storage.objects RLS by design; writes do not.
--      file_size_limit = 4 194 304 (4 MB) mirrors the helper-level guard and
--      stays under the 5 MB server-action bodySizeLimit with multipart headroom.
--      allowed_mime_types: enforced at the bucket too (unlike people-photos),
--      so a non-image content type is refused even from an admin session.
--      No HEIC: browsers and mail clients don't render it.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'event-images',
  'event-images',
  true,
  4194304,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- § 2  Storage RLS policy on storage.objects
--      bucket_id = 'event-images' is the FIRST condition (Risk 1 mitigation).
--      Admin only. No organizer policy, no anon policy → INSERT/UPDATE/DELETE
--      by anyone else is denied (RLS default deny). Public reads go through
--      the /object/public/ endpoint and need no SELECT policy.
-- ============================================================

CREATE POLICY "event_images_admin_all"
  ON storage.objects
  FOR ALL
  TO authenticated
  USING (
    bucket_id = 'event-images'
    AND public.is_admin()
  )
  WITH CHECK (
    bucket_id = 'event-images'
    AND public.is_admin()
  );

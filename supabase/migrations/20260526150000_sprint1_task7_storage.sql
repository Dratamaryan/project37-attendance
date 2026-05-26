-- Migration: sprint1_task7_storage
-- Creates the people-photos private bucket and 4 RLS policies on storage.objects.
-- Idempotent: bucket INSERT uses ON CONFLICT (id) DO NOTHING.
-- Policies: every USING / WITH CHECK has bucket_id = 'people-photos' as the
-- FIRST condition — Risk 1 mitigation (bucket_id filter on every policy).
-- Sprint 1 Task 7.

-- ============================================================
-- § 1  Bucket
--      Direct INSERT into storage.buckets — NOT storage.create_bucket() RPC,
--      which errors on re-run and is not idempotent across supabase db reset.
--      file_size_limit = 5 242 880 (5 MB) mirrors the helper-level guard.
--      allowed_mime_types = NULL: no restriction at bucket level; the helper
--      enforces the mime / extension whitelist (jpg, png, webp, heic).
--      public = false: NEVER set true. Public buckets bypass photo_publish_consent
--      gate entirely. All reads must go through signed URLs.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('people-photos', 'people-photos', false, 5242880, NULL)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- § 2  Storage RLS policies on storage.objects
--      Functions called as public.is_admin() / public.is_organizer() — fully
--      qualified to avoid search_path ambiguity from the storage schema context.
--      Anon role has no policy on this bucket → no access (RLS default deny).
-- ============================================================

-- Policy 1: Admin has full access to all objects in this bucket.
-- Covers admin uploads via service role (owner will be NULL for those —
-- organizer_update does NOT apply to them, admin_all does).
CREATE POLICY "admin_all"
  ON storage.objects
  FOR ALL
  TO authenticated
  USING (
    bucket_id = 'people-photos'
    AND public.is_admin()
  )
  WITH CHECK (
    bucket_id = 'people-photos'
    AND public.is_admin()
  );

-- Policy 2: Organizer can read file metadata.
-- Actual file bytes are accessed via signed URL (getPhotoSignedUrl),
-- not by reading storage.objects directly.
CREATE POLICY "organizer_select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'people-photos'
    AND public.is_organizer()
  );

-- Policy 3: Organizer can upload new files.
CREATE POLICY "organizer_insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'people-photos'
    AND public.is_organizer()
  );

-- Policy 4: Organizer can replace only their own uploads.
-- owner is set to auth.uid() when the upload is made via user JWT (server client).
-- Service-role uploads have owner = NULL and are governed by admin_all, not this policy.
CREATE POLICY "organizer_update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'people-photos'
    AND public.is_organizer()
    AND owner = auth.uid()
  )
  WITH CHECK (
    bucket_id = 'people-photos'
    AND public.is_organizer()
  );

-- No DELETE policy for organizer: deletion is admin-only (admin_all covers it).
-- This mirrors the people table pattern (only admin can set deleted_at).

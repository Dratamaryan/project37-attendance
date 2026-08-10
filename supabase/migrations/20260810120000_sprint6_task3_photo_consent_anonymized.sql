-- Migration: sprint6_task3_photo_consent_anonymized
-- S6-T3 (plan approved by architect) — additive only.
--
-- Adds people.photo_consent_state (tri-state provenance: did the roster/import
-- record this person as granted/refused/unknown photo-publish consent) and
-- people.anonymized_at (retention marker for anonymize-in-place scrubbing;
-- NULL = not anonymized, row id + FKs always preserved).
--
-- photo_publish_consent (existing boolean) stays the EFFECTIVE gate for actual
-- publishing and is intentionally NOT constrained against photo_consent_state
-- here: setPhotoConsent() (lib/actions/people.impl.ts) only ever writes the
-- boolean, and legitimately diverges it from the imported state — granting
-- consent for an 'unknown' person (future consent drive) or revoking consent
-- for a 'granted' person (admin action) are both valid, expected divergences.
-- A DB CHECK tying the two together would break both paths. See S6-T3 plan.
--
-- people is empty as of the S6-T2 wipe (confirmed live, 0 rows) so
-- NOT NULL DEFAULT 'unknown' costs nothing and avoids NULL/'unknown' meaning
-- the same thing two different ways.

CREATE TYPE consent_state_enum AS ENUM ('granted', 'refused', 'unknown');

ALTER TABLE people
  ADD COLUMN photo_consent_state consent_state_enum NOT NULL DEFAULT 'unknown',
  ADD COLUMN anonymized_at timestamptz;

# Language: English (see features/README.md for why).
Feature: Sending event invitations

  When an admin sends invitations for an event, everyone with an email on
  file gets one automatically. Anyone without an email can't be reached
  that way — the system needs to hand the organizer a clear list of exactly
  who those people are, so they can be followed up with by phone or
  WhatsApp instead.

  Scenario: People without an email land on a manual follow-up list
    Given "Has Email One" and "Has Email Two" are invited to an event, both with an email on file
    And "No Email Person" is invited to the same event, with no email on file
    When invitations are sent
    Then "Has Email One" and "Has Email Two" are each sent an invitation
    And "No Email Person" appears on the manual follow-up list instead
    And the manual follow-up list does not include "Has Email One" or "Has Email Two"

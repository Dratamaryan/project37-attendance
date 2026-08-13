# Language: English (see features/README.md for why).
Feature: Removing a member's personal details on request

  When someone asks to have their personal information removed, we
  anonymize their record — name, phone, and other identifying details are
  scrubbed — but their attendance history stays in place anonymously, so
  event statistics remain accurate.

  Scenario: A member's details are scrubbed while their attendance history remains
    Given a member named "Departing Member" who checked in to an event
    When an admin anonymizes "Departing Member"'s record
    Then "Departing Member"'s name and phone number are no longer stored
    And their attendance at the event is still recorded
    But it can no longer be traced back to their name

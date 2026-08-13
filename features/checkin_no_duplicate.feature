# Language: English (see features/README.md for why).
Feature: Checking a member in at an event

  On event day, a volunteer finds a member by phone number and checks them
  in. If the same person gets scanned twice — by accident, or by two
  volunteers at once — it must not create two attendance records. The
  second attempt should simply be recognized as already done.

  Scenario: A second check-in for the same person is recognized, not duplicated
    Given an event happening today
    And a member named "Returning Member"
    When a volunteer checks "Returning Member" in
    Then "Returning Member" is marked as checked in
    When a volunteer checks "Returning Member" in a second time
    Then the system recognizes "Returning Member" is already checked in
    And only one attendance record exists for "Returning Member"

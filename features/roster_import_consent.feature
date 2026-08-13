# Language: English (see features/README.md for why).
Feature: Roster import respects photo consent

  Every so often we import an updated roster spreadsheet. One of its
  questions asks each person whether photos of them can be shared in the
  group chat. Some people say yes, some say no, and some never answered at
  all. The single most important rule in this whole system is that someone
  who said no is never later treated as "maybe" or "not sure" — a "no" must
  stay a "no" through every import, forever.

  Scenario: Yes, no, and no-answer are each recorded correctly
    Given a roster spreadsheet listing:
      | Name            | Phone number  | Photo consent answer |
      | Wants Photos    | 0812000930501 | Ya                    |
      | Declines Photos | 0812000930502 | Tidak                 |
      | Never Answered  | 0812000930503 |                       |
    When the roster is imported
    Then "Wants Photos" is recorded as having agreed to photos
    And "Declines Photos" is recorded as having declined photos
    And "Never Answered" is recorded as not yet asked

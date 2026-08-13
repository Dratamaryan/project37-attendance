# Language: English (see features/README.md for why).
Feature: Photo consent determines who can be published

  The roster export marks each person as publishable or not, based on
  their consent answer. Someone who agreed can be published; someone who
  declined, or who was never asked, cannot.

  Scenario: Only members who agreed are marked publishable
    Given "Agreed Member" agreed to have their photo published
    And "Declined Member" declined to have their photo published
    And "Unasked Member" has never been asked
    When the roster export is generated
    Then "Agreed Member" is marked publishable
    And "Declined Member" is marked not publishable
    And "Unasked Member" is marked not publishable

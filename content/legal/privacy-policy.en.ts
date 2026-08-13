// Bundled at build time (static import) — not read via fs at request time.
// Vercel's output file tracing can't reliably resolve fs.readFile() calls behind a
// templated/dynamic path (`privacy-policy.${locale}.md`), which risks a missing-file
// 500 on a fresh deploy. A plain TS module sidesteps tracing entirely: any bundler that
// can resolve a normal `import` bundles this string with zero extra config.
// Source of truth: docs/privacy-policy.{id,en}.md (verbatim copy — do not reword).
export const privacyPolicyEn = `<!-- locale: en (secondary). Canonical: privacy-policy.id.md. Keep both files structurally in sync. -->

# Privacy Policy

*Effective: 13 August 2026 · Version: v1*

This Privacy Policy explains what personal data we collect, why we collect it, how we protect it, and what rights you have over it. We value the trust you place in us and are committed to using your data only for the benefit of the community.

## 1. Who We Are

This application is run by the **Project 37** community team ("we", "us") to record attendance and manage community member data. For any question about your privacy or your data, contact us at **project37events@gmail.com**.

## 2. Scope

This policy applies to every community member whose data is recorded in the application, and to the administrators and volunteers who hold accounts to operate it.

## 3. Data We Collect

We only collect the data needed to serve the community, including:

- **Basic identity:** full name, nickname, gender, place & date of birth.
- **Contact details:** phone number and email address (where available).
- **Community information:** origin parish, marital status, area of residence, and your role and group within the community.
- **Photo:** your profile photo, only if you provide one.
- **Attendance records:** the time and event when you were present.
- **Family details (where relevant):** spouse or children information, only if you provide it.

For administrators/volunteers with accounts, we also record account activity (such as sign-in times and actions taken) for security purposes.

## 4. Why We Collect It

Your data is used solely for the benefit of the community, namely to:

- record and manage attendance at community events;
- keep the member database accurate and up to date;
- send event invitations and reminders (such as birthday greetings);
- produce summary attendance statistics for ministry purposes.

We do **not** sell your data, do **not** use it for advertising, and do **not** share it for any commercial purpose.

## 5. Basis of Use & Consent

We process your data based on your consent and for the legitimate interests of the community. You may withdraw your consent at any time (see Section 8).

## 6. Photos

Your photo will only be displayed or published if you have given consent. If you have not given consent, your photo will not be published. You may change this choice at any time by contacting us.

## 7. Data Sharing

We do not share your personal data with outside parties, except with trusted technology service providers that help us run the application (for example data storage, email delivery, and notifications). These providers may only process data on our instructions. Some of these services may store data on servers located outside Indonesia with adequate safeguards. We will only disclose data where required by law.

## 8. Your Rights

In line with Law No. 27 of 2022 on Personal Data Protection, you have the right to:

- know what data we hold and why;
- request a copy of your data;
- correct inaccurate data;
- request that your data be deleted or anonymized;
- withdraw your consent;
- object to or restrict the use of your data.

To exercise these rights, contact **project37events@gmail.com**. We will respond within a reasonable time.

## 9. How Long We Keep Data

We keep your data for as long as you are part of the community. When you request it, or when you are no longer active, we will anonymize your data — your personal identity is removed while attendance records remain in anonymous form for community statistics.

## 10. Children's Data

Some community members may be under 18 years of age. We only collect and process children's data with the consent of a parent or guardian. Parents/guardians may contact us at any time to access, correct, or delete their child's data.

## 11. Security

We apply reasonable safeguards to protect your data, including restricting access to authorized administrators only. Even so, no system is entirely free of risk; we will always do our best to keep your data safe.

## 12. Changes to This Policy

We may update this Privacy Policy from time to time. Any changes will be marked with a new effective date on this page.

## 13. Contact Us

For any privacy question, request, or complaint, contact:

**project37events@gmail.com**
` as const

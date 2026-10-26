// Bundled at build time (static import) — not read via fs at request time.
// Vercel's output file tracing can't reliably resolve fs.readFile() calls behind a
// templated/dynamic path (`privacy-policy.${locale}.md`), which risks a missing-file
// 500 on a fresh deploy. A plain TS module sidesteps tracing entirely: any bundler that
// can resolve a normal `import` bundles this string with zero extra config.
// Source of truth: docs/privacy-policy.{id,en}.md (verbatim copy — do not reword).
export const privacyPolicyEn = `# Privacy Policy

*Effective: 26th October 2026 · Version: v2*

This Privacy Policy explains what personal data we collect, why we collect it, how we protect it, and what rights you have over it. We value the trust you place in us and are committed to using your data only for the benefit of the community.

## 1. Who We Are

This application is run by the **Project 37** community team ("we", "us") to record attendance, manage community member data, and receive attendance confirmations (RSVPs) for community events. For any question about your privacy or your data, contact us at **project37events@gmail.com**.

## 2. Scope

This policy applies to:

- every community member whose data is recorded in the application;
- anyone who fills in an attendance confirmation (RSVP) form through an event link, including people who are not yet community members;
- the administrators and volunteers who hold accounts to operate the application.

## 3. Data We Collect

We only collect the data needed to serve the community, including:

- **Basic identity:** full name, nickname, gender, place & date of birth.
- **Contact details:** phone number and email address (where available).
- **Community information:** origin parish, marital status, area of residence, and your role and group within the community.
- **Photo:** your profile photo, only if you provide one.
- **Attendance records:** the time and event when you were present.
- **Family details (where relevant):** spouse or children information, only if you provide it.
- **Attendance confirmations (RSVP):** phone/WhatsApp number, name (optional), your answer (attending, maybe, or not attending), the number of children coming with you, and whether you agree to be contacted again.

If the phone number you enter on the RSVP form already belongs to a community member, your confirmation is automatically linked to that member record. In that case the name you type is not stored, and the RSVP form never changes your member record.

For administrators/volunteers with accounts, we also record account activity (such as sign-in times and actions taken) for security purposes.

When you open the RSVP form, some technical data is also processed to keep the form secure (see Section 7).

## 4. Why We Collect It

Your data is used solely for the benefit of the community, namely to:

- record and manage attendance at community events;
- keep the member database accurate and up to date;
- send event invitations and reminders (such as birthday greetings);
- estimate attendance and prepare events based on attendance confirmations (RSVPs);
- contact you about upcoming activities. For RSVPs, we only do this if you tick the box agreeing to be contacted again;
- protect the RSVP form from spam and abuse;
- produce summary attendance statistics for ministry purposes.

We do **not** sell your data, do **not** use it for advertising, and do **not** share it for any commercial purpose.

## 5. Basis of Use & Consent

We process your data based on your consent and for the legitimate interests of the community. You may withdraw your consent at any time (see Section 8).

Agreeing to be contacted again on the RSVP form is voluntary and applies to each submission separately. Without that tick, we will not contact you on the basis of that RSVP.

## 6. Photos

Your photo will only be displayed or published if you have given consent. If you have not given consent, your photo will not be published. You may change this choice at any time by contacting us.

## 7. Data Sharing

We do not share your personal data with outside parties, except with trusted technology service providers that help us run the application. These providers may only process data on our instructions:

- **Supabase:** database, authentication, and photo storage (servers in Singapore).
- **Vercel:** application hosting (servers in Singapore).
- **Google:** email delivery (Gmail) and data backup storage (Google Drive).
- **GitHub:** runs the automated data backup process.
- **Telegram:** internal notifications for the community team, such as birthday lists and attendance summaries that include names.
- **Cloudflare:** protection of the RSVP form against bots (see below).

Some of these services store data on servers located outside Indonesia with adequate safeguards. We will only disclose data where required by law.

**RSVP form protection (Cloudflare Turnstile).** To prevent spam, the RSVP form uses Cloudflare Turnstile. When the form opens, Turnstile processes technical signals such as your IP address, TLS fingerprint, browser type (user-agent), and the site you are visiting, in order to tell people apart from bots. Turnstile is not intended to identify or profile you. For this protection, Cloudflare acts as a data processor on our behalf. Cloudflare also uses these signals to improve Turnstile's bot detection, and for that purpose it acts as an independent data controller. You can read more in [Cloudflare's Turnstile Privacy Addendum](https://www.cloudflare.com/turnstile-privacy-policy/).

In addition, our server briefly reads your IP address to limit excessive form submissions. The IP address is immediately turned into a random code (a hash), kept only in server memory for at most 10 minutes, and never logged or stored permanently.

## 8. Your Rights

In line with Law No. 27 of 2022 on Personal Data Protection, you have the right to:

- know what data we hold and why;
- request a copy of your data;
- correct inaccurate data;
- request that your data be deleted or anonymized;
- withdraw your consent;
- object to or restrict the use of your data.

These rights also apply to RSVP data. If you ask, we will anonymize the phone number and name on your RSVPs early.

To exercise these rights, contact **project37events@gmail.com**. We will respond within a reasonable time.

## 9. How Long We Keep Data

- **Member data:** kept for as long as you are part of the community. When you request it, or when you are no longer active, we will anonymize your data. Your personal identity is removed while attendance records remain in anonymous form for community statistics.
- **RSVP data:** the phone number and name on an RSVP are automatically anonymized 90 days after the event ends. Your answer and the number of children remain in anonymous form for event statistics.
- **IP addresses used to limit form submissions:** at most 10 minutes, in server memory only (see Section 7).
- **Backups:** database backups are kept for up to about one year and then deleted. Data that has already been anonymized may remain in older backups until those backups are deleted.

## 10. Children's Data

Some community members may be under 18 years of age. We only collect and process children's data with the consent of a parent or guardian. Parents/guardians may contact us at any time to access, correct, or delete their child's data.

On the RSVP form we only ask how many children are coming, without names or any other details about them.

## 11. Security

We apply reasonable safeguards to protect your data, including restricting access to authorized administrators only. Even so, no system is entirely free of risk; we will always do our best to keep your data safe.

## 12. Changes to This Policy

We may update this Privacy Policy from time to time. Any changes will be marked with a new effective date and version number on this page.

## 13. Contact Us

For any privacy question, request, or complaint, contact:

**project37events@gmail.com**` as const

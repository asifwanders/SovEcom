/**
 * English (`en`) default legal/content page
 * TEMPLATES for the default tenant.
 *
 * These are best-practice TEMPLATE defaults,
 * NOT authoritative legal prose. Every body opens with a prominent counsel
 * notice and uses `[BRACKETED]` placeholders for merchant-specific facts. A
 * merchant MUST review and complete each page with qualified legal counsel
 * before relying on it.
 *
 * The ONLY standardized statutory instrument reproduced here is the EU model
 * withdrawal form (Annex I(B), Directive 2011/83/EU) — an official, widely
 * published template — and even that sits inside a flagged template page with
 * `[TRADER ...]` placeholders.
 */
import type { SeedPagePack } from './types';

/** The counsel/template banner that opens every English seeded body. */
const NOTICE = `> ⚠️ **TEMPLATE — placeholder content.** Review and complete with qualified legal counsel before publishing to customers. Replace all \`[BRACKETED]\` placeholders (e.g. \`[COMPANY NAME]\`, \`[ADDRESS]\`, \`[EMAIL]\`, \`[DATE]\`) with your own details. This text is a starting point only and is **not** legal advice.`;

export const EN_PAGES: SeedPagePack = {
  privacy: {
    title: 'Privacy Policy',
    seoTitle: 'Privacy Policy',
    seoDescription: 'How [COMPANY NAME] collects, uses and protects your personal data.',
    body: `${NOTICE}

# Privacy Policy

_Last updated: [DATE]_

This Privacy Policy explains how **[COMPANY NAME]** ("we", "us") collects, uses and protects your personal data when you use our store at **[WEBSITE URL]**. It is provided as a template and must be adapted to your actual data practices and reviewed against the EU General Data Protection Regulation (GDPR) by qualified counsel.

## 1. Data controller

The data controller is **[COMPANY NAME]**, **[ADDRESS]**. You can contact us at **[EMAIL]**.

## 2. Personal data we collect

- Identity and contact details you provide (name, email, postal address, phone).
- Order and payment information needed to fulfil purchases.
- Technical data strictly necessary to operate the site.

_List only the data you actually process and remove anything that does not apply._

## 3. Purposes and legal bases

We process your data to perform our contract with you (order fulfilment), to comply with legal obligations (e.g. accounting), and where applicable on the basis of your consent. _Confirm the correct legal basis for each purpose with counsel._

## 4. Retention

We keep personal data only as long as necessary for the purposes above and as required by law. _State your actual retention periods here._

## 5. Your rights

Under the GDPR you may have the right to access, rectify, erase, restrict or object to the processing of your data, and to data portability. To exercise these rights contact **[EMAIL]**. You may also lodge a complaint with your supervisory authority (in France, the **CNIL**).

## 6. Contact

For any question about this policy, contact **[COMPANY NAME]** at **[EMAIL]**.`,
  },

  terms: {
    title: 'Terms & Conditions',
    seoTitle: 'Terms & Conditions',
    seoDescription: 'The terms and conditions of sale for purchases from [COMPANY NAME].',
    body: `${NOTICE}

# Terms & Conditions of Sale

_Last updated: [DATE]_

These Terms & Conditions of Sale ("Terms") govern purchases made from **[COMPANY NAME]**, **[ADDRESS]** ("we", "us"). They are a template and must be completed and reviewed by qualified counsel before use.

## 1. Scope

These Terms apply to every order placed on **[WEBSITE URL]**. By placing an order you accept these Terms.

## 2. Products and prices

Prices are shown in **[CURRENCY]** and include applicable taxes unless stated otherwise. We may change prices at any time, but orders are charged at the price displayed at the time of the order.

## 3. Orders

An order is confirmed once we send you an order confirmation. _Describe your actual ordering and confirmation process._

## 4. Payment

Payment is due at the time of order through the payment methods offered at checkout. _List your accepted payment methods._

## 5. Delivery

We aim to deliver to the address you provide within the timeframes shown at checkout. _State your real delivery terms, zones and costs._

## 6. Right of withdrawal

Consumers in the EU generally have a 14-day right of withdrawal. See our **Right of Withdrawal** page for details and the model withdrawal form. _Confirm the conditions and exceptions that apply to your goods with counsel._

## 7. Liability and warranties

Statutory warranties apply as required by law. _Complete this section with counsel — do not weaken consumer rights below the legal minimum._

## 8. Governing law and disputes

These Terms are governed by the law of **[COUNTRY]**. _Add your dispute-resolution and EU ODR-platform information here as advised by counsel._

## 9. Contact

For any question, contact **[COMPANY NAME]** at **[EMAIL]**.`,
  },

  cookies: {
    title: 'Cookie Policy',
    seoTitle: 'Cookie Policy',
    seoDescription: 'How [COMPANY NAME] uses cookies and similar technologies.',
    body: `${NOTICE}

# Cookie Policy

_Last updated: [DATE]_

This Cookie Policy explains how **[COMPANY NAME]** uses cookies and similar technologies on **[WEBSITE URL]**. It is a template and must be aligned with the cookies you actually set and reviewed by counsel (GDPR + ePrivacy).

## 1. What cookies are

Cookies are small files stored on your device. Some are strictly necessary to operate the site; others require your consent.

## 2. Cookies we use

- **Strictly necessary** cookies that are required for the site to function.
- _Add any analytics or preference cookies you use, with their purpose and lifetime. Non-essential cookies require prior consent._

## 3. Managing cookies

You can withdraw or change your consent at any time via **[COOKIE SETTINGS LINK]** and through your browser settings.

## 4. Contact

For questions about cookies, contact **[EMAIL]**.`,
  },

  'legal-notice': {
    title: 'Legal Notice',
    seoTitle: 'Legal Notice',
    seoDescription: 'Legal notice and publisher information for [COMPANY NAME].',
    body: `${NOTICE}

# Legal Notice

_Last updated: [DATE]_

This Legal Notice (the EU "mentions légales" / imprint) identifies the publisher of **[WEBSITE URL]**. Complete every field with your real details and have it reviewed by counsel.

## Publisher

- **Company name:** [COMPANY NAME]
- **Legal form:** [LEGAL FORM]
- **Registered address:** [ADDRESS]
- **Company registration number:** [REGISTRATION NUMBER]
- **VAT number:** [VAT NUMBER]
- **Contact email:** [EMAIL]
- **Publication director:** [PUBLICATION DIRECTOR]

## Hosting

- **Host:** [HOST NAME]
- **Host address:** [HOST ADDRESS]

_Add any other disclosures required in your jurisdiction (e.g. professional registration, capital)._`,
  },

  withdrawal: {
    title: 'Right of Withdrawal',
    seoTitle: 'Right of Withdrawal',
    seoDescription: 'Your right of withdrawal and the EU model withdrawal form.',
    body: `${NOTICE}

# Right of Withdrawal

_Last updated: [DATE]_

This page describes the consumer right of withdrawal and includes the **model withdrawal form**. The explanatory text below is a template — confirm the exact conditions, deadlines and exceptions that apply to your goods with qualified counsel. The model form itself is the official EU statutory template (Annex I(B), Directive 2011/83/EU).

## Your right to withdraw

You generally have the right to withdraw from your purchase within 14 days without giving any reason, subject to the legal exceptions. _State your actual withdrawal terms, the return address and who bears the return costs._

To exercise the right of withdrawal you must inform **[COMPANY NAME]** of your decision by an unequivocal statement (for example, a letter sent by post or email to **[EMAIL]**). You may use the model withdrawal form below, but it is not obligatory.

## Model withdrawal form

_(Complete and return this form only if you wish to withdraw from the contract.)_

- To **[TRADER NAME]**, **[TRADER ADDRESS]**, **[TRADER EMAIL]**:
- I/We (*) hereby give notice that I/We (*) withdraw from my/our (*) contract of sale of the following goods (*)/for the supply of the following service (*),
- Ordered on (*)/received on (*): ____________________
- Name of consumer(s): ____________________
- Address of consumer(s): ____________________
- Signature of consumer(s) (only if this form is notified on paper): ____________________
- Date: ____________________

(*) Delete as appropriate.`,
  },
};

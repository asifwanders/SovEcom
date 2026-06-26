/**
 * transactional-email message catalogs.
 *
 * Per-locale (EN/FR) STRING catalogs for the transactional emails. Only the prose
 * is localized — dynamic DATA (order number, money amounts, currency, credit-note
 * reference, addresses) is interpolated by the template functions and is identical in
 * every locale (amounts stay integer-cents formatted by the shared `formatMoney`).
 *
 * Subjects that embed the order number are functions taking the order number so the
 * data stays out of the catalog. EN/FR key parity is asserted by the i18n spec.
 *
 * FR copy mirrors the storefront and admin tone. No legally-binding wording is invented
 * here — these are operational transactional notices, not legal/withdrawal text.
 */
import type { EmailLocale } from './email-locale';

export interface OrderConfirmationMessages {
  /** Subject line; takes the order number for interpolation. */
  subject: (orderNumber: string) => string;
  heading: string;
  /** Intro line; takes the order number. */
  intro: (orderNumber: string) => string;
  labelSubtotal: string;
  labelDiscount: string;
  labelShipping: string;
  labelTax: string;
  labelTotal: string;
  shipTo: string;
  /** Plain-text "Order"/"Commande" label preceding the order number. */
  orderLabel: string;
  /** Plain-text greeting line. */
  textThanks: string;
  /** Plain-text "Items:" header. */
  textItems: string;
}

export interface OrderShippedMessages {
  subject: (orderNumber: string) => string;
  heading: string;
  intro: (orderNumber: string) => string;
  shipTo: string;
  /** Plain-text "Order"/"Commande" label preceding the order number. */
  orderLabel: string;
  textGoodNews: string;
}

export interface RefundIssuedMessages {
  subject: (orderNumber: string) => string;
  heading: string;
  intro: (orderNumber: string) => string;
  creditNote: string;
  disclaimer: string;
  /** Plain-text "Order"/"Commande" label preceding the order number. */
  orderLabel: string;
  /** Plain-text "Refund amount"/"Montant remboursé" label. */
  refundAmount: string;
  textIntro: string;
}

/**
 * Email-change verification (verify-before-switch).
 * Sent to the NEW (pending) address; the single-use link confirms the swap. This is
 * a SECURITY email on the direct mail path (NOT order-bound), so it carries no order
 * data — only localized prose around the verify URL (interpolated by the template).
 */
export interface EmailChangeVerificationMessages {
  subject: string;
  heading: string;
  /** Body line introducing the action (no data). */
  intro: string;
  /** Anchor text for the verify link (HTML) / lead-in for the plain-text URL. */
  action: string;
  /** Expiry + safety note ("expires in 1 hour … ignore if you didn't request"). */
  disclaimer: string;
}

/**
 * Email-change SECURITY NOTICE sent to the customer's CURRENT/OLD address (NOT the
 * new one). Two kinds:
 *   - `requested`: a change to {newEmail} was REQUESTED (alert the owner mid-flight);
 *   - `confirmed`: the account email WAS changed to {newEmail} (post-swap, to the OLD
 *     address so the previous owner can react).
 * The new email IS included in the body — the legitimate owner benefits from seeing the
 * target. Each `subject`/`intro` takes the new email so the data stays out of the catalog.
 */
export interface EmailChangeNoticeMessages {
  requested: {
    subject: string;
    heading: string;
    intro: (newEmail: string) => string;
    disclaimer: string;
  };
  confirmed: {
    subject: string;
    heading: string;
    intro: (newEmail: string) => string;
    disclaimer: string;
  };
}

/**
 * Customer UNAUTH password-reset email. Sent to the customer's CURRENT address;
 * the single-use link opens the storefront reset page. This is a SECURITY email on
 * the direct mail path (NOT order-bound), so it carries no order data — only
 * localized prose around the reset URL (interpolated by the template). DISTINCT
 * from the admin EN-only `sendPasswordReset` (different URL + localized).
 */
export interface CustomerPasswordResetMessages {
  subject: string;
  heading: string;
  /** Body line introducing the action (no data). */
  intro: string;
  /** Anchor text for the reset link (HTML) / lead-in for the plain-text URL. */
  action: string;
  /** Expiry + safety note ("expires in 1 hour … ignore if you didn't request"). */
  disclaimer: string;
}

export interface EmailMessages {
  orderConfirmation: OrderConfirmationMessages;
  orderShipped: OrderShippedMessages;
  refundIssued: RefundIssuedMessages;
  emailChangeVerification: EmailChangeVerificationMessages;
  emailChangeNotice: EmailChangeNoticeMessages;
  customerPasswordReset: CustomerPasswordResetMessages;
}

const en: EmailMessages = {
  orderConfirmation: {
    subject: (o) => `Order ${o} confirmed`,
    heading: 'Thank you for your order!',
    intro: (o) => `Order ${o} is confirmed.`,
    labelSubtotal: 'Subtotal',
    labelDiscount: 'Discount',
    labelShipping: 'Shipping',
    labelTax: 'Tax',
    labelTotal: 'Total',
    shipTo: 'Ship to',
    orderLabel: 'Order',
    textThanks: 'Thank you for your order!',
    textItems: 'Items:',
  },
  orderShipped: {
    subject: (o) => `Order ${o} is on its way`,
    heading: 'Your order is on its way',
    intro: (o) => `Order ${o} has shipped.`,
    shipTo: 'Shipping to',
    orderLabel: 'Order',
    textGoodNews: 'Good news — your order has shipped.',
  },
  refundIssued: {
    subject: (o) => `Refund issued for order ${o}`,
    heading: 'Refund issued',
    intro: (o) => `A refund has been issued for order ${o}.`,
    creditNote: 'Credit note',
    disclaimer:
      'The refund will appear on your original payment method according to your provider’s timelines.',
    orderLabel: 'Order',
    refundAmount: 'Refund amount',
    textIntro: 'A refund has been issued for your order.',
  },
  emailChangeVerification: {
    subject: 'Confirm your new email address',
    heading: 'Confirm your new email address',
    intro: 'A request was made to change the email address on your account to this one.',
    action: 'Confirm email change',
    disclaimer:
      'This link expires in 1 hour. If you did not request this change, you can safely ignore this email — your account email will not change.',
  },
  emailChangeNotice: {
    requested: {
      subject: 'Email change requested on your account',
      heading: 'Email change requested',
      intro: (newEmail) =>
        `A change of your account email to ${newEmail} was requested. The new address must be confirmed before it takes effect.`,
      disclaimer:
        'If this was not you, secure your account now by changing your password — the change will not take effect until the new address is confirmed.',
    },
    confirmed: {
      subject: 'Your account email was changed',
      heading: 'Your account email was changed',
      intro: (newEmail) => `Your account email was changed to ${newEmail}.`,
      disclaimer: 'If this was not you, contact support immediately.',
    },
  },
  customerPasswordReset: {
    subject: 'Reset your password',
    heading: 'Reset your password',
    intro: 'A password reset was requested for your account.',
    action: 'Reset password',
    disclaimer:
      'This link expires in 1 hour. If you did not request this, you can safely ignore this email — your password will not change.',
  },
};

const fr: EmailMessages = {
  orderConfirmation: {
    subject: (o) => `Commande ${o} confirmée`,
    heading: 'Merci pour votre commande !',
    intro: (o) => `La commande ${o} est confirmée.`,
    labelSubtotal: 'Sous-total',
    labelDiscount: 'Remise',
    labelShipping: 'Livraison',
    labelTax: 'TVA',
    labelTotal: 'Total',
    shipTo: 'Livrer à',
    orderLabel: 'Commande',
    textThanks: 'Merci pour votre commande !',
    textItems: 'Articles :',
  },
  orderShipped: {
    subject: (o) => `Votre commande ${o} est en route`,
    heading: 'Votre commande est en route',
    intro: (o) => `La commande ${o} a été expédiée.`,
    shipTo: 'Expédiée à',
    orderLabel: 'Commande',
    textGoodNews: 'Bonne nouvelle — votre commande a été expédiée.',
  },
  refundIssued: {
    subject: (o) => `Remboursement émis pour la commande ${o}`,
    heading: 'Remboursement émis',
    intro: (o) => `Un remboursement a été émis pour la commande ${o}.`,
    creditNote: 'Avoir',
    disclaimer:
      'Le remboursement apparaîtra sur votre moyen de paiement d’origine selon les délais de votre prestataire.',
    orderLabel: 'Commande',
    refundAmount: 'Montant remboursé',
    textIntro: 'Un remboursement a été émis pour votre commande.',
  },
  emailChangeVerification: {
    subject: 'Confirmez votre nouvelle adresse e-mail',
    heading: 'Confirmez votre nouvelle adresse e-mail',
    intro:
      'Une demande de modification de l’adresse e-mail de votre compte vers celle-ci a été effectuée.',
    action: 'Confirmer le changement d’e-mail',
    disclaimer:
      'Ce lien expire dans 1 heure. Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet e-mail — l’adresse de votre compte ne sera pas modifiée.',
  },
  emailChangeNotice: {
    requested: {
      subject: 'Demande de changement d’e-mail sur votre compte',
      heading: 'Changement d’e-mail demandé',
      intro: (newEmail) =>
        `Une modification de l’e-mail de votre compte vers ${newEmail} a été demandée. La nouvelle adresse doit être confirmée avant de prendre effet.`,
      disclaimer:
        'Si vous n’êtes pas à l’origine de cette demande, sécurisez votre compte en changeant votre mot de passe — le changement ne prendra pas effet tant que la nouvelle adresse n’est pas confirmée.',
    },
    confirmed: {
      subject: 'L’e-mail de votre compte a été modifié',
      heading: 'L’e-mail de votre compte a été modifié',
      intro: (newEmail) => `L’e-mail de votre compte a été modifié vers ${newEmail}.`,
      disclaimer:
        'Si vous n’êtes pas à l’origine de cette modification, contactez immédiatement le support.',
    },
  },
  customerPasswordReset: {
    subject: 'Réinitialisez votre mot de passe',
    heading: 'Réinitialisez votre mot de passe',
    intro: 'Une réinitialisation de mot de passe a été demandée pour votre compte.',
    action: 'Réinitialiser le mot de passe',
    disclaimer:
      'Ce lien expire dans 1 heure. Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet e-mail — votre mot de passe ne sera pas modifié.',
  },
};

const CATALOGS: Record<EmailLocale, EmailMessages> = { en, fr };

/** Return the message catalog for a resolved locale (always present for En/FR). */
export function emailMessages(locale: EmailLocale): EmailMessages {
  return CATALOGS[locale];
}

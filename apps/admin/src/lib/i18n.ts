export const messages = {
  en: {
    auth: {
      loginTitle: 'Sign in to SovEcom',
      emailLabel: 'Email address',
      emailPlaceholder: 'you@example.com',
      passwordLabel: 'Password',
      passwordPlaceholder: '••••••••',
      loginButton: 'Sign in',
      forgotPassword: 'Forgot password?',
      loginError: 'Invalid credentials. Please try again.',
      lockoutError: 'Account locked. Please try again later.',
      twoFactorTitle: 'Two-factor authentication',
      twoFactorLabel: 'Authentication code',
      twoFactorPlaceholder: '000000',
      twoFactorSubmit: 'Verify',
      twoFactorError: 'Invalid code. Please try again.',
      twoFactorSetupTitle: 'Set up two-factor authentication',
      twoFactorSetupDescription:
        'Scan the QR code with your authenticator app and enter the code below.',
      twoFactorSecretLabel: 'Secret key',
      twoFactorConfirm: 'Confirm and activate',
      twoFactorDisableTitle: 'Disable two-factor authentication',
      twoFactorDisableDescription:
        'Enter your password and a current authentication code to disable 2FA.',
      twoFactorDisableButton: 'Disable 2FA',
      forgotPasswordTitle: 'Reset your password',
      forgotPasswordDescription: 'Enter your email address and we will send you a reset link.',
      forgotPasswordButton: 'Send reset link',
      forgotPasswordSuccess: 'If an account exists, a reset link has been sent.',
      resetPasswordTitle: 'Choose a new password',
      resetPasswordButton: 'Reset password',
      resetPasswordSuccess: 'Your password has been reset. Please sign in.',
      passwordPolicy: 'Must be at least 12 characters.',
      logout: 'Sign out',
      logoutSuccess: 'You have been signed out.',
    },
    layout: {
      dashboard: 'Dashboard',
      products: 'Products',
      categories: 'Categories',
      tags: 'Tags',
      pages: 'Pages',
      orders: 'Orders',
      returns: 'Returns',
      emailLog: 'Email log',
      disputes: 'Disputes',
      discounts: 'Discounts',
      shipping: 'Shipping',
      taxes: 'Taxes',
      webhooks: 'Webhooks',
      themes: 'Themes',
      slots: 'Slots',
      modules: 'Modules',
      analytics: 'Analytics',
      customers: 'Customers',
      auditLog: 'Audit log',
      businessIdentity: 'Business identity',
      settings: 'Settings',
      collapseSidebar: 'Collapse sidebar',
      expandSidebar: 'Expand sidebar',
      openMenu: 'Open menu',
      closeMenu: 'Close menu',
      language: 'Language',
    },
    pages: {
      title: 'Content pages',
      newPage: 'New page',
      editPage: 'Edit page',
      createPage: 'New page',
      empty: 'No pages yet.',
      colSlug: 'Slug',
      colTitle: 'Title',
      colLocale: 'Locale',
      colStatus: 'Status',
      colUpdated: 'Updated',
      colActions: 'Actions',
      fieldSlug: 'Slug',
      fieldTitle: 'Title',
      fieldBody: 'Body',
      fieldBodyHint: 'Markdown is supported. Rendered as sanitized HTML on the storefront.',
      fieldLocale: 'Locale',
      fieldStatus: 'Status',
      fieldSeoTitle: 'SEO title',
      fieldSeoDescription: 'SEO description',
      statusDraft: 'Draft',
      statusPublished: 'Published',
      allStatuses: 'All statuses',
      allLocales: 'All locales',
      localeEn: 'English',
      localeFr: 'French',
      deleteTitle: 'Delete page',
      deleteConfirm: 'This action cannot be undone. The page will be permanently removed.',
      duplicateSlug: 'A page with this slug already exists for this locale.',
      saveCreate: 'Create page',
      saveEdit: 'Save changes',
    },
    themes: {
      title: 'Themes',
      empty: 'No themes installed. Install a theme package (.tgz) to get started.',
      bundledNote:
        'The bundled “default” and “boutique” themes are not listed here yet — that depends on a pending seeding decision.',
      install: 'Install theme',
      installTitle: 'Install a theme',
      installDescription: 'Upload a verified theme package (.tgz, max 8 MiB).',
      fileLabel: 'Theme package (.tgz)',
      colName: 'Name',
      colVersion: 'Version',
      colStatus: 'Status',
      colActions: 'Actions',
      active: 'Active',
      activate: 'Activate',
      editSettings: 'Edit settings',
      settingsTitle: 'Theme settings',
      settingsDescription: 'Edit the theme settings bag as JSON. This replaces the whole bag.',
      settingsLabel: 'Settings (JSON)',
      invalidJson: 'Settings must be valid JSON (an object).',
      deleteTitle: 'Uninstall theme',
      deleteConfirm: 'This removes the theme and its files. This action cannot be undone.',
      fileRequired: 'Please choose a .tgz file to install.',
      tooLarge: 'That file exceeds the 8 MiB limit. Please choose a smaller package.',
    },
    slots: {
      title: 'Module slots',
      subtitle:
        'Where enabled modules render in the storefront. When two modules target the same slot, pick a winner.',
      conflictsHeading: 'Conflicts to resolve',
      resolvedHeading: 'Resolved slots',
      allResolved: 'All slots resolved — nothing to decide.',
      noneResolved: 'No slots are resolved yet.',
      emptyNoSlots: 'No module slots. Enable a module that targets a slot to see it here.',
      colSlot: 'Slot',
      colModule: 'Module',
      colComponent: 'Component',
      useModule: 'Use this module',
      staleResolution:
        'That module is no longer a candidate for this slot — the list has been refreshed.',
    },
    modules: {
      title: 'Modules',
      subtitle: 'Sandboxed add-ons installed for your store. Enable, disable, or uninstall them.',
      empty: 'No modules installed. Install a module package (.tgz) to get started.',
      install: 'Install module',
      installTitle: 'Install a module',
      installDescription: 'Upload a verified module package (.tgz, max 8 MiB).',
      fileLabel: 'Module package (.tgz)',
      colName: 'Name',
      colVersion: 'Version',
      colStatus: 'Status',
      colActions: 'Actions',
      enabled: 'Enabled',
      disabled: 'Disabled',
      enable: 'Enable',
      disable: 'Disable',
      uninstall: 'Uninstall',
      deleteTitle: 'Uninstall module',
      deleteConfirm: 'This removes the module and its files. This action cannot be undone.',
      fileRequired: 'Please choose a .tgz file to install.',
      tooLarge: 'That file exceeds the 8 MiB limit. Please choose a smaller package.',
    },
    analytics: {
      title: 'Analytics',
      subtitle:
        'Connect privacy-first analytics. Plausible is cookieless; Google Analytics and Meta Pixel load only with visitor consent and carry RGPD obligations.',
      plausibleLabel: 'Plausible domain',
      plausibleHint:
        'The domain registered in your Plausible account (cookieless, no consent needed). Comma-separate multiple domains. Leave blank to disable.',
      ga4Label: 'Google Analytics measurement ID',
      ga4Hint:
        'e.g. G-XXXXXXXXXX. Loads only for visitors who accept analytics cookies. Leave blank to disable.',
      metaLabel: 'Meta Pixel ID',
      metaHint:
        'Numeric pixel ID. Loads only for visitors who accept marketing cookies. Leave blank to disable.',
      rgpdGa:
        'Google Analytics sends visitor data to Google, a non-EU processor. You are responsible for a lawful basis, a data-processing agreement, and disclosing it in your privacy policy.',
      rgpdMeta:
        'The Meta Pixel sends visitor data to Meta, a non-EU processor, for ad targeting. You are responsible for a lawful basis, a DPA, and disclosing it in your privacy policy.',
      ackGa: 'I understand the RGPD implications of enabling Google Analytics.',
      ackMeta: 'I understand the RGPD implications of enabling the Meta Pixel.',
      ackRequired: 'Please acknowledge the RGPD warning before saving.',
      saved: 'Analytics settings saved.',
    },
    common: {
      loading: 'Loading…',
      save: 'Save',
      cancel: 'Cancel',
      confirm: 'Confirm',
      delete: 'Delete',
      edit: 'Edit',
      create: 'Create',
      search: 'Search',
      back: 'Back',
      required: 'Required',
      invalidEmail: 'Invalid email address',
      minLength: (n: number) => `Must be at least ${n} characters`,
      genericError: 'Something went wrong. Please try again.',
    },
  },
  fr: {
    auth: {
      loginTitle: 'Connexion à SovEcom',
      emailLabel: 'Adresse e-mail',
      emailPlaceholder: 'vous@exemple.com',
      passwordLabel: 'Mot de passe',
      passwordPlaceholder: '••••••••',
      loginButton: 'Se connecter',
      forgotPassword: 'Mot de passe oublié ?',
      loginError: 'Identifiants invalides. Veuillez réessayer.',
      lockoutError: 'Compte verrouillé. Veuillez réessayer plus tard.',
      twoFactorTitle: 'Authentification à deux facteurs',
      twoFactorLabel: "Code d'authentification",
      twoFactorPlaceholder: '000000',
      twoFactorSubmit: 'Vérifier',
      twoFactorError: 'Code invalide. Veuillez réessayer.',
      twoFactorSetupTitle: 'Configurer la double authentification',
      twoFactorSetupDescription:
        "Scannez le QR code avec votre application d'authentification et saisissez le code ci-dessous.",
      twoFactorSecretLabel: 'Clé secrète',
      twoFactorConfirm: 'Confirmer et activer',
      twoFactorDisableTitle: 'Désactiver la double authentification',
      twoFactorDisableDescription:
        'Saisissez votre mot de passe et un code actuel pour désactiver la 2FA.',
      twoFactorDisableButton: 'Désactiver la 2FA',
      forgotPasswordTitle: 'Réinitialiser votre mot de passe',
      forgotPasswordDescription:
        'Saisissez votre adresse e-mail et nous vous enverrons un lien de réinitialisation.',
      forgotPasswordButton: 'Envoyer le lien',
      forgotPasswordSuccess: 'Si un compte existe, un lien de réinitialisation a été envoyé.',
      resetPasswordTitle: 'Choisissez un nouveau mot de passe',
      resetPasswordButton: 'Réinitialiser le mot de passe',
      resetPasswordSuccess: 'Votre mot de passe a été réinitialisé. Veuillez vous connecter.',
      passwordPolicy: 'Doit contenir au moins 12 caractères.',
      logout: 'Se déconnecter',
      logoutSuccess: 'Vous avez été déconnecté.',
    },
    layout: {
      dashboard: 'Tableau de bord',
      products: 'Produits',
      categories: 'Catégories',
      tags: 'Tags',
      pages: 'Pages',
      orders: 'Commandes',
      returns: 'Retours',
      emailLog: 'Journal des e-mails',
      disputes: 'Litiges',
      discounts: 'Remises',
      shipping: 'Livraison',
      taxes: 'Taxes',
      webhooks: 'Webhooks',
      themes: 'Thèmes',
      slots: 'Emplacements',
      modules: 'Modules',
      analytics: 'Mesure d’audience',
      customers: 'Clients',
      auditLog: "Journal d'audit",
      businessIdentity: 'Identité de l’entreprise',
      settings: 'Paramètres',
      collapseSidebar: 'Réduire la barre latérale',
      expandSidebar: 'Étendre la barre latérale',
      openMenu: 'Ouvrir le menu',
      closeMenu: 'Fermer le menu',
      language: 'Langue',
    },
    pages: {
      title: 'Pages de contenu',
      newPage: 'Nouvelle page',
      editPage: 'Modifier la page',
      createPage: 'Nouvelle page',
      empty: 'Aucune page pour le moment.',
      colSlug: 'Slug',
      colTitle: 'Titre',
      colLocale: 'Langue',
      colStatus: 'Statut',
      colUpdated: 'Modifiée',
      colActions: 'Actions',
      fieldSlug: 'Slug',
      fieldTitle: 'Titre',
      fieldBody: 'Contenu',
      fieldBodyHint: 'Le Markdown est pris en charge. Rendu en HTML assaini sur la boutique.',
      fieldLocale: 'Langue',
      fieldStatus: 'Statut',
      fieldSeoTitle: 'Titre SEO',
      fieldSeoDescription: 'Description SEO',
      statusDraft: 'Brouillon',
      statusPublished: 'Publiée',
      allStatuses: 'Tous les statuts',
      allLocales: 'Toutes les langues',
      localeEn: 'Anglais',
      localeFr: 'Français',
      deleteTitle: 'Supprimer la page',
      deleteConfirm: 'Cette action est irréversible. La page sera définitivement supprimée.',
      duplicateSlug: 'Une page avec ce slug existe déjà pour cette langue.',
      saveCreate: 'Créer la page',
      saveEdit: 'Enregistrer les modifications',
    },
    themes: {
      title: 'Thèmes',
      empty: 'Aucun thème installé. Installez un paquet de thème (.tgz) pour commencer.',
      bundledNote:
        'Les thèmes intégrés « default » et « boutique » ne sont pas encore listés ici — cela dépend d’une décision d’amorçage à venir.',
      install: 'Installer un thème',
      installTitle: 'Installer un thème',
      installDescription: 'Téléversez un paquet de thème vérifié (.tgz, max 8 Mio).',
      fileLabel: 'Paquet de thème (.tgz)',
      colName: 'Nom',
      colVersion: 'Version',
      colStatus: 'Statut',
      colActions: 'Actions',
      active: 'Actif',
      activate: 'Activer',
      editSettings: 'Modifier les réglages',
      settingsTitle: 'Réglages du thème',
      settingsDescription:
        'Modifiez le sac de réglages du thème en JSON. Cela remplace tout le sac.',
      settingsLabel: 'Réglages (JSON)',
      invalidJson: 'Les réglages doivent être un JSON valide (un objet).',
      deleteTitle: 'Désinstaller le thème',
      deleteConfirm: 'Cela supprime le thème et ses fichiers. Cette action est irréversible.',
      fileRequired: 'Veuillez choisir un fichier .tgz à installer.',
      tooLarge: 'Ce fichier dépasse la limite de 8 Mio. Veuillez choisir un paquet plus petit.',
    },
    slots: {
      title: 'Emplacements de modules',
      subtitle:
        'Où les modules activés s’affichent dans la boutique. Si deux modules ciblent le même emplacement, choisissez un gagnant.',
      conflictsHeading: 'Conflits à résoudre',
      resolvedHeading: 'Emplacements résolus',
      allResolved: 'Tous les emplacements sont résolus — rien à décider.',
      noneResolved: 'Aucun emplacement résolu pour le moment.',
      emptyNoSlots:
        'Aucun emplacement de module. Activez un module qui cible un emplacement pour le voir ici.',
      colSlot: 'Emplacement',
      colModule: 'Module',
      colComponent: 'Composant',
      useModule: 'Utiliser ce module',
      staleResolution:
        'Ce module n’est plus un candidat pour cet emplacement — la liste a été actualisée.',
    },
    modules: {
      title: 'Modules',
      subtitle:
        'Extensions en bac à sable installées pour votre boutique. Activez, désactivez ou désinstallez-les.',
      empty: 'Aucun module installé. Installez un paquet de module (.tgz) pour commencer.',
      install: 'Installer un module',
      installTitle: 'Installer un module',
      installDescription: 'Téléversez un paquet de module vérifié (.tgz, max 8 Mio).',
      fileLabel: 'Paquet de module (.tgz)',
      colName: 'Nom',
      colVersion: 'Version',
      colStatus: 'Statut',
      colActions: 'Actions',
      enabled: 'Activé',
      disabled: 'Désactivé',
      enable: 'Activer',
      disable: 'Désactiver',
      uninstall: 'Désinstaller',
      deleteTitle: 'Désinstaller le module',
      deleteConfirm: 'Cela supprime le module et ses fichiers. Cette action est irréversible.',
      fileRequired: 'Veuillez choisir un fichier .tgz à installer.',
      tooLarge: 'Ce fichier dépasse la limite de 8 Mio. Veuillez choisir un paquet plus petit.',
    },
    analytics: {
      title: 'Mesure d’audience',
      subtitle:
        'Connectez une mesure d’audience respectueuse de la vie privée. Plausible est sans cookie ; Google Analytics et le Pixel Meta ne se chargent qu’avec le consentement du visiteur et impliquent des obligations RGPD.',
      plausibleLabel: 'Domaine Plausible',
      plausibleHint:
        'Le domaine enregistré dans votre compte Plausible (sans cookie, aucun consentement requis). Séparez plusieurs domaines par une virgule. Laissez vide pour désactiver.',
      ga4Label: 'Identifiant de mesure Google Analytics',
      ga4Hint:
        'p. ex. G-XXXXXXXXXX. Ne se charge que pour les visiteurs qui acceptent les cookies de mesure d’audience. Laissez vide pour désactiver.',
      metaLabel: 'Identifiant du Pixel Meta',
      metaHint:
        'Identifiant numérique du pixel. Ne se charge que pour les visiteurs qui acceptent les cookies marketing. Laissez vide pour désactiver.',
      rgpdGa:
        'Google Analytics envoie les données des visiteurs à Google, un sous-traitant hors UE. Vous êtes responsable d’une base légale, d’un accord de traitement des données et de sa mention dans votre politique de confidentialité.',
      rgpdMeta:
        'Le Pixel Meta envoie les données des visiteurs à Meta, un sous-traitant hors UE, à des fins de ciblage publicitaire. Vous êtes responsable d’une base légale, d’un DPA et de sa mention dans votre politique de confidentialité.',
      ackGa: 'Je comprends les implications RGPD de l’activation de Google Analytics.',
      ackMeta: 'Je comprends les implications RGPD de l’activation du Pixel Meta.',
      ackRequired: 'Veuillez accepter l’avertissement RGPD avant d’enregistrer.',
      saved: 'Paramètres de mesure d’audience enregistrés.',
    },
    common: {
      loading: 'Chargement…',
      save: 'Enregistrer',
      cancel: 'Annuler',
      confirm: 'Confirmer',
      delete: 'Supprimer',
      edit: 'Modifier',
      create: 'Créer',
      search: 'Rechercher',
      back: 'Retour',
      required: 'Requis',
      invalidEmail: 'Adresse e-mail invalide',
      minLength: (n: number) => `Doit contenir au moins ${n} caractères`,
      genericError: 'Une erreur est survenue. Veuillez réessayer.',
    },
  },
};

export type Locale = 'en' | 'fr';

/** localStorage key for the persisted admin UI locale. */
export const LOCALE_STORAGE_KEY = 'sovecom.admin.locale';

/** Default admin UI locale — reconciled to `en` to match storefront. */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Read the persisted locale from localStorage, falling back to the default.
 * Defensive against SSR/jsdom edge cases and malformed values.
 */
export function readStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === 'en' || stored === 'fr') return stored;
  } catch {
    // localStorage unavailable — fall through to default
  }
  return DEFAULT_LOCALE;
}

// Module-level mutable global backing the non-reactive `t()`/`tfn()` helpers.
// Initialized from localStorage so direct `t()` callers (rendered before the
// provider mounts, or outside React) resolve in the persisted locale. The
// reactive LocaleProvider keeps this in sync via setLocale() on every switch.
let currentLocale: Locale = readStoredLocale();

export function setLocale(locale: Locale) {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function t<K extends keyof (typeof messages)['en']>(
  section: K,
  key: keyof (typeof messages)['en'][K],
): string {
  const sectionMsg = messages[currentLocale][section] as Record<
    string,
    string | ((n: number) => string)
  >;
  const enSectionMsg = messages.en[section] as Record<string, string | ((n: number) => string)>;
  const msg = sectionMsg[key as string] ?? enSectionMsg[key as string];
  return typeof msg === 'function' ? msg(0) : (msg ?? (key as string));
}

export function tfn<K extends keyof (typeof messages)['en']>(
  section: K,
  key: keyof (typeof messages)['en'][K],
  ...args: number[]
): string {
  const sectionMsg = messages[currentLocale][section] as Record<
    string,
    string | ((n: number) => string)
  >;
  const enSectionMsg = messages.en[section] as Record<string, string | ((n: number) => string)>;
  const msg = sectionMsg[key as string] ?? enSectionMsg[key as string];
  if (typeof msg === 'function') {
    return msg(args[0] ?? 0);
  }
  return (msg ?? (key as string)) as string;
}

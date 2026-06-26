/**
 * French (`fr`) default legal/content page
 * TEMPLATES for the default tenant. Mirrors `en.ts` 1:1 (same slug set, same
 * placeholders), FR tone consistent with the storefront/admin/email FR copy.
 *
 * Best-practice TEMPLATE defaults, NOT
 * authoritative legal prose. Every body opens with the counsel notice and uses
 * `[ENTRE CROCHETS]` placeholders. A merchant MUST review and complete each page
 * with qualified legal counsel before relying on it.
 *
 * The ONLY standardized statutory instrument reproduced is the EU model
 * withdrawal form ("formulaire type de rétractation", Annexe I(B), Directive
 * 2011/83/UE) — inside a flagged template with `[PROFESSIONNEL ...]` placeholders.
 */
import type { SeedPagePack } from './types';

/** Bandeau d'avertissement « modèle / conseil » en tête de chaque corps FR. */
const NOTICE = `> ⚠️ **MODÈLE — contenu indicatif.** À relire et compléter avec un conseil juridique qualifié avant publication aux clients. Remplacez tous les champs \`[ENTRE CROCHETS]\` (par ex. \`[NOM DE LA SOCIÉTÉ]\`, \`[ADRESSE]\`, \`[EMAIL]\`, \`[DATE]\`) par vos propres informations. Ce texte n'est qu'un point de départ et **ne constitue pas** un avis juridique.`;

export const FR_PAGES: SeedPagePack = {
  privacy: {
    title: 'Politique de confidentialité',
    seoTitle: 'Politique de confidentialité',
    seoDescription:
      'Comment [NOM DE LA SOCIÉTÉ] collecte, utilise et protège vos données personnelles.',
    body: `${NOTICE}

# Politique de confidentialité

_Dernière mise à jour : [DATE]_

Cette politique de confidentialité explique comment **[NOM DE LA SOCIÉTÉ]** (« nous ») collecte, utilise et protège vos données personnelles lorsque vous utilisez notre boutique **[URL DU SITE]**. Il s'agit d'un modèle à adapter à vos pratiques réelles et à faire valider au regard du Règlement général sur la protection des données (RGPD) par un conseil qualifié.

## 1. Responsable du traitement

Le responsable du traitement est **[NOM DE LA SOCIÉTÉ]**, **[ADRESSE]**. Vous pouvez nous contacter à **[EMAIL]**.

## 2. Données personnelles collectées

- Données d'identité et de contact que vous fournissez (nom, email, adresse postale, téléphone).
- Informations de commande et de paiement nécessaires à l'exécution des achats.
- Données techniques strictement nécessaires au fonctionnement du site.

_Ne mentionnez que les données que vous traitez réellement et supprimez ce qui ne s'applique pas._

## 3. Finalités et bases légales

Nous traitons vos données pour exécuter notre contrat avec vous (traitement des commandes), pour respecter nos obligations légales (par ex. comptabilité) et, le cas échéant, sur la base de votre consentement. _Confirmez la base légale appropriée pour chaque finalité avec un conseil._

## 4. Durée de conservation

Nous conservons les données personnelles uniquement le temps nécessaire aux finalités ci-dessus et conformément à la loi. _Indiquez ici vos durées de conservation réelles._

## 5. Vos droits

En vertu du RGPD, vous pouvez disposer d'un droit d'accès, de rectification, d'effacement, de limitation et d'opposition au traitement, ainsi que d'un droit à la portabilité. Pour exercer ces droits, contactez **[EMAIL]**. Vous pouvez également introduire une réclamation auprès de votre autorité de contrôle (en France, la **CNIL**).

## 6. Contact

Pour toute question sur cette politique, contactez **[NOM DE LA SOCIÉTÉ]** à **[EMAIL]**.`,
  },

  terms: {
    title: 'Conditions générales de vente',
    seoTitle: 'Conditions générales de vente',
    seoDescription: 'Les conditions générales de vente des achats auprès de [NOM DE LA SOCIÉTÉ].',
    body: `${NOTICE}

# Conditions générales de vente (CGV)

_Dernière mise à jour : [DATE]_

Les présentes conditions générales de vente (« CGV ») régissent les achats effectués auprès de **[NOM DE LA SOCIÉTÉ]**, **[ADRESSE]** (« nous »). Il s'agit d'un modèle à compléter et à faire valider par un conseil qualifié avant utilisation.

## 1. Champ d'application

Les présentes CGV s'appliquent à toute commande passée sur **[URL DU SITE]**. En passant commande, vous acceptez ces CGV.

## 2. Produits et prix

Les prix sont indiqués en **[DEVISE]** et incluent les taxes applicables, sauf mention contraire. Nous pouvons modifier les prix à tout moment, mais les commandes sont facturées au prix affiché au moment de la commande.

## 3. Commandes

Une commande est confirmée dès l'envoi d'une confirmation de commande. _Décrivez votre processus réel de commande et de confirmation._

## 4. Paiement

Le paiement est exigible au moment de la commande via les moyens proposés au paiement. _Indiquez vos moyens de paiement acceptés._

## 5. Livraison

Nous livrons à l'adresse que vous indiquez dans les délais affichés au paiement. _Précisez vos conditions, zones et frais de livraison réels._

## 6. Droit de rétractation

Les consommateurs de l'UE disposent en général d'un droit de rétractation de 14 jours. Voir notre page **Droit de rétractation** pour les détails et le formulaire type de rétractation. _Confirmez avec un conseil les conditions et exceptions applicables à vos biens._

## 7. Responsabilité et garanties

Les garanties légales s'appliquent dans les conditions prévues par la loi. _Complétez cette section avec un conseil — ne réduisez pas les droits des consommateurs en deçà du minimum légal._

## 8. Droit applicable et litiges

Les présentes CGV sont régies par le droit de **[PAYS]**. _Ajoutez ici vos informations de règlement des litiges et la plateforme européenne de RLL, selon les conseils reçus._

## 9. Contact

Pour toute question, contactez **[NOM DE LA SOCIÉTÉ]** à **[EMAIL]**.`,
  },

  cookies: {
    title: 'Politique relative aux cookies',
    seoTitle: 'Politique relative aux cookies',
    seoDescription: 'Comment [NOM DE LA SOCIÉTÉ] utilise les cookies et technologies similaires.',
    body: `${NOTICE}

# Politique relative aux cookies

_Dernière mise à jour : [DATE]_

Cette politique explique comment **[NOM DE LA SOCIÉTÉ]** utilise les cookies et technologies similaires sur **[URL DU SITE]**. Il s'agit d'un modèle à aligner sur les cookies que vous déposez réellement et à faire valider par un conseil (RGPD + ePrivacy).

## 1. Qu'est-ce qu'un cookie

Les cookies sont de petits fichiers stockés sur votre appareil. Certains sont strictement nécessaires au fonctionnement du site ; d'autres requièrent votre consentement.

## 2. Cookies utilisés

- Cookies **strictement nécessaires** au fonctionnement du site.
- _Ajoutez les éventuels cookies de mesure d'audience ou de préférence que vous utilisez, avec leur finalité et leur durée. Les cookies non essentiels requièrent un consentement préalable._

## 3. Gérer les cookies

Vous pouvez retirer ou modifier votre consentement à tout moment via **[LIEN PARAMÈTRES COOKIES]** et dans les réglages de votre navigateur.

## 4. Contact

Pour toute question sur les cookies, contactez **[EMAIL]**.`,
  },

  'legal-notice': {
    title: 'Mentions légales',
    seoTitle: 'Mentions légales',
    seoDescription: "Mentions légales et informations sur l'éditeur de [NOM DE LA SOCIÉTÉ].",
    body: `${NOTICE}

# Mentions légales

_Dernière mise à jour : [DATE]_

Les présentes mentions légales identifient l'éditeur de **[URL DU SITE]**. Complétez chaque champ avec vos informations réelles et faites-les valider par un conseil.

## Éditeur

- **Dénomination sociale :** [NOM DE LA SOCIÉTÉ]
- **Forme juridique :** [FORME JURIDIQUE]
- **Siège social :** [ADRESSE]
- **Numéro d'immatriculation (RCS) :** [NUMÉRO RCS]
- **Numéro de TVA intracommunautaire :** [NUMÉRO TVA]
- **Email de contact :** [EMAIL]
- **Directeur de la publication :** [DIRECTEUR DE PUBLICATION]

## Hébergement

- **Hébergeur :** [NOM HÉBERGEUR]
- **Adresse de l'hébergeur :** [ADRESSE HÉBERGEUR]

_Ajoutez toute autre mention obligatoire dans votre juridiction (par ex. immatriculation professionnelle, capital social)._`,
  },

  withdrawal: {
    title: 'Droit de rétractation',
    seoTitle: 'Droit de rétractation',
    seoDescription: "Votre droit de rétractation et le formulaire type de rétractation de l'UE.",
    body: `${NOTICE}

# Droit de rétractation

_Dernière mise à jour : [DATE]_

Cette page décrit le droit de rétractation du consommateur et inclut le **formulaire type de rétractation**. Le texte explicatif ci-dessous est un modèle — confirmez avec un conseil qualifié les conditions, délais et exceptions exacts applicables à vos biens. Le formulaire type lui-même est le modèle officiel de l'UE (Annexe I(B), Directive 2011/83/UE).

## Votre droit de rétractation

Vous disposez en général d'un délai de 14 jours pour vous rétracter de votre achat, sans avoir à motiver votre décision, sous réserve des exceptions légales. _Indiquez vos conditions réelles de rétractation, l'adresse de retour et qui supporte les frais de retour._

Pour exercer le droit de rétractation, vous devez notifier votre décision à **[NOM DE LA SOCIÉTÉ]** au moyen d'une déclaration dénuée d'ambiguïté (par exemple, lettre envoyée par la poste ou email à **[EMAIL]**). Vous pouvez utiliser le modèle de formulaire ci-dessous, mais ce n'est pas obligatoire.

## Formulaire type de rétractation

_(Veuillez compléter et renvoyer le présent formulaire uniquement si vous souhaitez vous rétracter du contrat.)_

- À l'attention de **[NOM DU PROFESSIONNEL]**, **[ADRESSE DU PROFESSIONNEL]**, **[EMAIL DU PROFESSIONNEL]** :
- Je/Nous (*) vous notifie/notifions (*) par la présente ma/notre (*) rétractation du contrat portant sur la vente du bien (*)/pour la prestation de service (*) ci-dessous,
- Commandé le (*)/reçu le (*) : ____________________
- Nom du (des) consommateur(s) : ____________________
- Adresse du (des) consommateur(s) : ____________________
- Signature du (des) consommateur(s) (uniquement en cas de notification du présent formulaire sur papier) : ____________________
- Date : ____________________

(*) Rayez la mention inutile.`,
  },
};

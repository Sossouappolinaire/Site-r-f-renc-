# Cœur & Connexions

Site de rencontre privé avec validation manuelle des profils, photo de profil obligatoire, codes de connexion à usage unique et espace administrateur.

## Déploiement Node.js

Le ZIP contient une application autonome. Sur Render, Railway, Fly.io ou un VPS :

1. Décompressez l’archive.
2. Lancez `npm install`.
3. Lancez `npm start`.
4. Configurez les variables suivantes :
   - `ADMIN_EMAIL` : adresse de connexion de l’administrateur ;
   - `ADMIN_PASSWORD` : mot de passe de l’administrateur ;
   - `SESSION_SECRET` : longue valeur aléatoire, différente en production.

Le serveur écoute sur `PORT` lorsqu’il est fourni par l’hébergeur, sinon sur le port `8080`.

## Envoi des codes

Dans l’espace administrateur, ouvrez **Envoi des codes** :

- **Envoi manuel par Gmail** prépare un brouillon que l’administrateur vérifie puis envoie lui-même ;
- **API Mailgun** demande les trois valeurs de la capture :
  - la clé API Mailgun ;
  - le domaine Mailgun ou Sandbox ;
  - l’URL de base, généralement `https://api.mailgun.net`.

Le bouton **Vérifier et enregistrer** appelle l’API Mailgun pour confirmer le domaine avant d’enregistrer la configuration. La clé est chiffrée avec `SESSION_SECRET` et n’est jamais affichée dans l’interface.

Après confirmation d’un profil, le code est envoyé automatiquement uniquement si la vérification Mailgun a réussi. En cas d’échec, le profil reste confirmé mais l’échec est inscrit dans le journal des emails afin d’être corrigé sans perdre la trace de l’opération.

Une photo de profil est obligatoire lors de l’inscription. Elle est enregistrée sur le compte comme photo principale et affichée comme avatar dans l’espace membre. L’administrateur conserve la validation du profil avant tout envoi de code.

## Mot de passe oublié

Depuis la page de connexion, un membre peut demander la réinitialisation de son mot de passe :

1. il saisit son adresse email ;
2. un code à 6 chiffres valable 15 minutes est généré ;
3. il saisit ce code ;
4. il choisit et confirme son nouveau mot de passe.

Lorsque Mailgun est configuré et vérifié, le code est envoyé automatiquement à l’adresse du compte. En mode manuel, la demande est enregistrée dans le journal administrateur avec un brouillon Gmail que l’administrateur peut ouvrir et envoyer.

## Données

Les comptes sont conservés dans `data.json`, créé automatiquement au premier démarrage. Sur un hébergeur dont le disque est temporaire, configurez un disque persistant avant une utilisation réelle.

## Sécurité

- Limitation des tentatives (connexion, codes à 6 chiffres, réinitialisation, inscription, mot de passe oublié), par IP et par compte.
- Les photos sont réduites côté navigateur (1280 px, JPEG) ; le serveur refuse tout ce qui n’est pas JPEG/PNG/WebP/GIF ou dépasse 2 Mo par photo.
- Sessions avec expiration (7 jours ; 15 minutes pour les étapes code/réinitialisation) et cookie `Secure` en production (`NODE_ENV=production` ou `RENDER`).
- Les requêtes `POST` provenant d’un autre site sont refusées (contrôle de l’en-tête `Origin`).
- Le mot de passe administrateur est comparé en temps constant.

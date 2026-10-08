# Cœur & Connexions

Site de rencontre privé avec inscription immédiate (sans validation par l’administrateur), photo de profil obligatoire, code secret affiché à l’inscription et espace administrateur.

## Déploiement Node.js

Le ZIP contient une application autonome. Sur Render, Railway, Fly.io ou un VPS :

1. Décompressez l’archive.
2. Lancez `npm install`.
3. Lancez `npm start`.
4. Configurez les variables suivantes :
   - `ADMIN_EMAIL` : adresse de connexion de l’administrateur ;
   - `ADMIN_PASSWORD` : mot de passe de l’administrateur ;
   - `SESSION_SECRET` : longue valeur aléatoire, différente en production ;
   - `ADMIN_WHATSAPP` : numéro WhatsApp de l’administrateur, au format international sans « + » (ex. `22995501564`). Sans ce numéro, le mot de passe oublié s’applique tout de suite et aucun message n’est redirigé vers WhatsApp.

Le serveur écoute sur `PORT` lorsqu’il est fourni par l’hébergeur, sinon sur le port `8080`.

## Inscription et premier code

Aucune validation de l’administrateur : le compte est actif dès l’inscription. À la fin de l’inscription, une fenêtre affiche le message de confirmation qui serait normalement parti par e-mail, avec le code secret à 6 chiffres (valable 30 jours, à usage unique). La personne doit cocher l’acceptation des conditions avant de pouvoir **Copier le code** et continuer. Ce code est demandé à la première connexion. Aucun e-mail n’est envoyé pour cela.

Une photo de profil est obligatoire lors de l’inscription ; elle devient la photo principale du compte.

La connexion propose « Se souvenir de moi » (session de 30 jours ; sinon 12 heures et cookie de session).

## Mot de passe oublié (sans e-mail, confirmé par l’administrateur)

1. Le membre saisit son adresse e-mail.
2. Il saisit le numéro de téléphone indiqué à l’inscription ; s’il ne correspond pas, la demande est refusée.
3. Si le numéro correspond, une fenêtre affiche le code de réinitialisation (6 chiffres, 1 heure, usage unique).
4. Il saisit le code, puis choisit et confirme son nouveau mot de passe.
5. **Si `ADMIN_WHATSAPP` est configuré** : WhatsApp s’ouvre automatiquement vers l’administrateur avec un message prérempli, et le compte est mis **en attente** (connexion impossible, sessions fermées) jusqu’à la confirmation de l’administrateur dans **Nouveaux mots de passe**. Confirmer active le nouveau mot de passe ; refuser rétablit l’ancien.
6. **Si `ADMIN_WHATSAPP` n’est pas configuré** : aucune redirection WhatsApp. Le mot de passe est modifié tout de suite et une fenêtre indique : « Mot de passe modifié. Vous pouvez vous connecter à votre compte, mais vous ne pourrez pas recevoir les notifications s’il y a un client. »

Aucune API e-mail n’est utilisée.

## Présence des membres

La rubrique **Profils inscrits** indique pour chaque personne « En ligne » ou « Déconnecté depuis … » (ou « Jamais connecté »). Est considéré en ligne un membre actif depuis moins de 2 minutes qui ne s’est pas déconnecté ; la liste se rafraîchit toute seule toutes les 20 secondes.

## Données

Les comptes sont conservés dans `data.json`, créé automatiquement au premier démarrage. Sur un hébergeur dont le disque est temporaire, configurez un disque persistant avant une utilisation réelle.

## Sécurité

- Limitation des tentatives (connexion, codes à 6 chiffres, réinitialisation, inscription, mot de passe oublié), par IP et par compte.
- Les photos sont réduites côté navigateur (1280 px, JPEG) ; le serveur refuse tout ce qui n’est pas JPEG/PNG/WebP/GIF ou dépasse 2 Mo par photo.
- Sessions avec expiration (7 jours ; 15 minutes pour les étapes code/réinitialisation) et cookie `Secure` en production (`NODE_ENV=production` ou `RENDER`).
- Les requêtes `POST` provenant d’un autre site sont refusées (contrôle de l’en-tête `Origin`).
- Le mot de passe administrateur est comparé en temps constant.

## Plan de ce soir (nouveau)

- Membre : « Plan de ce soir » → demande (vidéo 15 s max + WhatsApp). Admin : « Plan de mes clients » → « Qui est intéressé » diffuse la demande (sous un pseudo) aux membres du sexe opposé.
- Les intéressés envoient photo + vidéo + WhatsApp. L'admin appuie sur « Mise en contact » pour montrer leur photo au demandeur, qui appuie sur « Choisir ».
- Le bouton « Payer maintenant pour être en contact » ouvre le lien de paiement réglé par l'admin (Discussions de mes clients → Lien du bouton « Payer maintenant pour être en contact »). Le bouton « Payer maintenant pour être en contact » ouvre seulement le lien de paiement et active `success.html`. Après le paiement, le prestataire doit rediriger le client directement vers `https://VOTRE-SITE/success.html` (« URL de succès / de retour »). Si le client y arrive dans les 10 minutes suivant le clic, la discussion s'ouvre automatiquement et la page affiche les informations du demandeur et du contact (prénom, photo, WhatsApp). Au-delà de 10 minutes, `success.html` est bloquée : la personne choisie est écartée et la demande revient en attente d'une autre personne (les autres personnes présentées sont de nouveau proposées). Sans clic préalable sur le bouton, la page est refusée. Variable facultative : `CHAT_GRACE_SECONDS` (600 par défaut).
- À minuit (fuseau APP_TZ, défaut Africa/Porto-Novo) les discussions sont effacées chez les membres ; elles restent dans data.json et sont exportées dans exports/discussions-AAAA-MM-JJ.csv (aussi via le bouton « Exporter vers Excel »).
- Vidéos et photos sont stockées dans le dossier media/. Sur Render, il faut un disque persistant monté sur le dossier de l'application, sinon data.json et media/ sont perdus à chaque redéploiement.
- Suppression des vidéos : une vidéo (demande ou réponse) est supprimée du disque 10 minutes après sa première lecture par l'administrateur (balayage toutes les 15 s ; variable facultative `VIDEO_DELETE_SECONDS`). Une vidéo jamais lue est conservée. Les photos et les discussions ne sont pas concernées.

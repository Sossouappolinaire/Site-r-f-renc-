# Cœur & Connexions

Version modernisée du site de rencontre avec :

- configuration centralisée dans `config.js` ;
- interface responsive `index.html` avec barre de chargement colorée au démarrage ;
- animation de progression pendant une inscription ou un enregistrement ;
- écran de succès visible 3 secondes après l’inscription ;
- validation manuelle par l’administrateur ;
- préparation d’un message Gmail de confirmation contenant un code secret personnel à 6 chiffres ;
- vérification du code lors de la première connexion ;
- code haché, unique et à usage unique ;
- espace utilisateur, messages, photos privées et espace administrateur.

## Déploiement Render

1. Décompresser l’archive et envoyer le dossier dans un dépôt GitHub.
2. Dans Render, créer un **Web Service** relié au dépôt.
3. Utiliser `npm install` comme commande de build et `npm start` comme commande de démarrage.
4. Configurer les variables suivantes :

   - `ADMIN_EMAIL` : email qui reçoit les nouvelles inscriptions ;
   - `ADMIN_PASSWORD` : mot de passe privé de l’administrateur ;
   - `SESSION_SECRET` : longue valeur aléatoire ;
   
`config.js` récupère automatiquement ces valeurs depuis `process.env` après le déploiement. Il ne faut pas remplacer les valeurs vides par un mot de passe ou une valeur secrète dans ce fichier.

## Confirmation par Gmail

Quand une personne clique sur **Inscription**, le serveur génère un code secret à 6 chiffres et le conserve chiffré. Quand l’administrateur clique ensuite sur **Confirmer**, le serveur confirme le compte et prépare le message avec ce même code. L’interface ouvre Gmail dans un nouvel onglet avec :

- l’adresse Gmail de la personne déjà renseignée ;
- l’objet déjà renseigné ;
- le message complet et le code déjà renseignés.

L’administrateur vérifie le message puis clique sur **Envoyer** dans Gmail. Aucun service d’email, aucune clé API Resend et aucune adresse d’expéditeur technique ne sont nécessaires.

`SESSION_SECRET` est une longue valeur aléatoire qui signe les sessions. Dans `render.yaml`, Render la génère automatiquement avec `generateValue: true`; il ne faut pas l’inventer ni la publier.

## Important pour les données

Le fichier `data.json` est créé automatiquement. Le stockage local d’un hébergeur gratuit peut être effacé lors d’un redémarrage ou d’un nouveau déploiement. Pour conserver les comptes et photos en production, utilisez un disque persistant ou remplacez `data.json` par PostgreSQL et un stockage d’objets.

## Peut-on le déployer partout ?

`index.html` peut être servi par presque n’importe quel hébergeur statique, mais l’inscription, l’administrateur, la validation, les sessions et les emails nécessitent le serveur Node.js. L’application complète doit donc être déployée sur un hébergeur qui accepte Node.js, comme Render, Railway, Fly.io, un VPS ou Replit Deployments. Un hébergement HTML statique seul ne suffit pas.

Les conditions affichées et envoyées par email sont une base produit, pas un avis juridique. Faites-les relire et adapter aux règles de votre pays avant ouverture publique.
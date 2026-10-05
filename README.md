# Poste

Application personnelle de veille et de suivi de candidatures. TypeScript, Fastify, React, PostgreSQL, Graphile Worker et Playwright. Discord est le canal par defaut. Aucune integration externe ni soumission automatique n'est active par defaut.

## Lancement local (Windows, macOS ou Linux)

Node >=22.18 requis. `npm ci`, puis `npx playwright install chromium`, puis `npm run dev`.
Le lanceur demarre un vrai PostgreSQL local, l'API, les deux workers et Vite. Il affiche l'URL (habituellement http://127.0.0.1:5173 ; un port libre est choisi si necessaire). Mot de passe local : `local-development-only`, a remplacer via `APP_PASSWORD` dans `.env`. Les donnees restent dans `.local/`. Aucun exemple n'est ajoute automatiquement.

## Serveur prive

Copier `.env.example` vers `.env`, renseigner un mot de passe aleatoire de 20 caracteres minimum, `SESSION_SECRET` de 32 caracteres minimum, et le mot de passe PostgreSQL dans les deux variables correspondantes. Definir `APP_ORIGIN` sur l'origine exacte du navigateur. `docker compose up -d --build` construit le dashboard et execute les migrations avant les services. Le port est lie a localhost : utiliser un tunnel SSH (`ssh -L 3001:127.0.0.1:3001 serveur`) sur votre reseau WireGuard, ou un reverse proxy HTTPS lie uniquement a l'adresse VPN. Ne pas publier le port PostgreSQL.

Les secrets acceptent aussi une variable `NOM_FILE` pointant vers un fichier monte. `.env`, documents, sauvegardes et sessions sont exclus de Git. Les images et dependances sont verrouillees par `package-lock.json`; la base de l'image reste a maintenir.

## Configuration et imports

Renseigner profil, competences, metiers et criteres dans Configuration. Valider le profil lorsque ses faits et criteres ont ete verifies. Chaque sauvegarde cree une version et recalcule les scores. Les CV d'une ancienne version ne permettent plus la soumission.

Importer des fichiers `.eml` ou une liste JSON via le dashboard. Exemple complet dans `examples/jobs.json`. Les emails ne permettent pas toujours de retrouver entreprise, salaire ou description : ces champs restent inconnus. Les liens de tracking non reconnus exigent un import JSON de l'offre finale ; ils ne sont pas suivis automatiquement. Les donnees brutes et revisions sont conservees pour retraitement.

Pour IMAP : configurer `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD`, puis activer Boite email. Le curseur UID + UIDVALIDITY est persistant ; collecte toutes les cinq minutes, 100 messages maximum par passage. Preferer une boite dediee avec uniquement des alertes. Pour Discord, renseigner `DISCORD_WEBHOOK_URL`. Telegram et Slack sont optionnels. Les notifications ont une cle logique unique ; un resultat reseau incertain n'est pas renvoye automatiquement, car les webhooks ne garantissent pas une livraison exactement une fois.

Pour l'IA : renseigner `AI_BASE_URL` (API HTTPS publique compatible Chat Completions), `AI_API_KEY`, `AI_MODEL` et activer l'analyse. Le modele doit accepter JSON et `max_completion_tokens`. Le budget est un registre conservateur de reservations, pas une facture : parametrer `AI_CALL_RESERVE_EUR` au-dessus du cout maximum d'un appel pour le modele choisi, et definir aussi une limite chez le fournisseur. Les reservations echouees restent comptees. Les offres seules ayant passe les filtres sont analysees. Les lettres exigent une API configuree ; les CV n'en ont pas besoin. La lettre inclut des faits exacts selectionnes par identifiants ; son ouverture et sa conclusion proviennent de templates pour eviter des affirmations inventees. Aucun envoi externe n'est effectue pendant les tests.

## Sources et formulaires autorises

Indeed et LinkedIn fonctionnent par imports/alertes, sans scraping ni Easy Apply automatise. Meteojob, HelloWork et WTTJ ne sont pas declares scrapeables par defaut. Ajouter un connecteur RSS ou HTML seulement apres verification des conditions et autorisations ; joindre une preuve dans `authorizationEvidence`. La lecture HTML recherche des donnees JSON-LD JobPosting. Les URL sont HTTPS, les destinations privees bloquees et les domaines de redirection doivent appartenir a `allowedHosts`.

Un connecteur formulaire est lie a l'URL exacte d'une offre : configurer ses champs par labels accessibles, les cles `name/email/phone` ou celles de `profile.answers`, le champ CV, le bouton final et le texte exact de confirmation. Exemple dans `examples/form.json`. Ne jamais mapper une declaration juridique ou une question engageante. Les champs non reconnus, checkbox/radio, CAPTCHA et controles invalides interrompent la preparation.

Generer un CV puis ouvrir le PDF et approuver apres controle visuel et du contenu. Ajouter l'offre au suivi, selectionner le connecteur et lancer Preparer. Cette simulation remplit les champs sans cliquer sur Soumettre. Apres verification du parcours, activer la soumission du connecteur. Soumettre passe par score >=85, aucune inconnue, profil valide, documents approuves, analyse IA complete sans reserves si active, et maximum cinq tentatives par jour. Le runner fonctionne en file, sans nouvelle decision utilisateur pour les champs deja valides. Il n'effectue pas de candidatures spontanees sur toutes les offres de la base.

La machine d'etats protege contre les reprises : une interruption apres la reservation de soumission donne `unknown`, jamais un nouvel envoi. Verifier la plateforme puis utiliser les boutons de resolution avec une preuve. Les transitions Kanban ne peuvent contourner ce verrou. Un connecteur modifie exige une nouvelle simulation. Activer sa soumission ou approuver un document declenche aussi la mise en file automatique des offres correspondantes eligibles. Pour ouvrir une session dediee sur un poste prive : `npm run sessions -- identifiant` avec les memes DATABASE_URL/SESSIONS_DIR ; fermer le navigateur apres connexion. Ne pas ouvrir simultanement ce profil avec le runner. Le serveur headless n'expose aucun bureau distant.

## Exploitation et sauvegardes

Les workers publient un heartbeat ; le dashboard montre leur etat, les erreurs et la livraison des notifications. Une erreur structurelle repetee trois fois suspend le connecteur ; un challenge/restriction le suspend immediatement. Collecte HTTP toutes les six heures, execution serialisee par connecteur, backoff et respect de Retry-After. Arret global pour collecte, IA, notifications et runner ; une soumission deja partie doit finir sa verification.

Sauvegarde quotidienne : creer une cle age hors serveur, mettre sa cle publique dans `BACKUP_AGE_RECIPIENT`, puis `docker compose --profile backup up -d backup`. L'archive chiffree contient le dump PostgreSQL, les PDF et sessions. Conserver la cle privee separement et copier les archives hors serveur. Restaurer dans un environnement isole chaque mois : dechiffrer avec `age -d -i cle.txt`, extraire dans un repertoire vide, restaurer `database.dump` avec `pg_restore --clean --if-exists`, restaurer `/data` et `/sessions` avec permissions du compte node, puis verifier une offre et son PDF. Le test automatise `npm run test:integration` verifie un aller-retour PostgreSQL ; le test mensuel complet avec vos cles reste une operation d'exploitation. Les archives doivent etre prises quand le runner est arrete pour figer ses fichiers de session.

## Verification

`npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build`, puis `npm run test:e2e`. Les tests d'integration et navigateur demarrent leurs propres bases et services, sans utiliser vos donnees ni credentials externes. `pg_dump` et `pg_restore` de la meme version majeure que la base doivent etre dans PATH pour le test d'integration (ou definir `PG_BIN`). Les preuves du runner comprennent des evenements, metadonnees et captures avec champs et identite masques, conservees sept jours ; aucune trace brute contenant le CV ou des cookies n'est conservee.

# Poste

Application personnelle de veille et de suivi de candidatures. TypeScript, Fastify, React, PostgreSQL, Graphile Worker et Playwright. Discord est le canal par defaut. Aucune integration externe ni soumission automatique n'est active par defaut.

## Lancement local (Windows, macOS ou Linux)

Node >=22.18 requis. `npm ci`, puis `npx playwright install chromium`, puis `npm run dev`.
Le lanceur demarre un vrai PostgreSQL local, l'API, les deux workers et Vite. Il affiche l'URL (habituellement http://127.0.0.1:5173 ; un port libre est choisi si necessaire). Mot de passe local : `local-development-only`, a remplacer via `APP_PASSWORD` dans `.env`. Les donnees restent dans `.local/`. Aucun exemple n'est ajoute automatiquement.

## Serveur prive

La production utilise `compose.production.yaml` et une image GHCR privee epinglee par digest, commune a app/worker/runner. La CI teste cette image avant publication sur `main`; le digest est disponible dans le resume et l'artefact `image-digest`. Aucun deploiement automatique. Le Compose historique reste disponible pour les builds locaux.

Sur Linux, installer Docker Compose, Bash, jq, util-linux (`flock`), age et AWS CLI. Cloner dans `/opt/poste`, creer un utilisateur operateur `poste` disposant des droits Docker (equivalents a root), puis copier `.env.example` vers `.env` avec permissions 600. Renseigner APP_PASSWORD (20 caracteres minimum), SESSION_SECRET (32 minimum), POSTGRES_PASSWORD et le meme mot de passe dans DATABASE_URL (URL-encoder les caracteres speciaux). Definir APP_ORIGIN sur l'origine exacte du navigateur. Pour l'outillage operateur, utiliser les variables explicites du fichier prive `.env`; l'application accepte toujours les variantes `NOM_FILE`.

Configurer un bucket S3 prive, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION, S3_BUCKET et eventuellement S3_ENDPOINT_URL HTTPS. Le compte stockage doit pouvoir lire/ecrire/lister/supprimer uniquement les prefixes `daily/` et `weekly/` dedies a Poste. Mettre uniquement la cle publique age dans BACKUP_AGE_RECIPIENT; conserver la cle privee hors serveur. Se connecter au registre avec un jeton limite a `read:packages` (`docker login ghcr.io`).

```bash
export POSTE_IMAGE=ghcr.io/garder500/job-aggregator@sha256:DIGEST_DE_L_ARTEFACT
bash ops/poste doctor
bash ops/poste deploy "$POSTE_IMAGE"
ssh -N -L 3001:127.0.0.1:3001 utilisateur@serveur
```

Ouvrir http://localhost:3001 avec APP_ORIGIN=http://localhost:3001. Le port est lie a localhost; PostgreSQL n'est jamais publie. Un reverse proxy HTTPS lie uniquement au VPN reste facultatif. Les ressources sont reglables via SERVICE_CPUS/SERVICE_MEMORY et POSTGRES_CPUS/POSTGRES_MEMORY; logs limites a trois fichiers de 10 Mo par service. Un conteneur unhealthy n'est pas automatiquement redemarre par Docker; les heartbeats restent visibles au dashboard. Sans supervision externe, une panne totale ne genere aucune alerte.

Les commandes operateur sont exclusives (`flock`). Un deploiement suspend les nouvelles taches, attend le runner jusqu'a quatre minutes, arrete app/worker/runner, sauvegarde, applique les migrations puis attend les controles de sante avant reprise. En cas d'echec, maintenance conservee; ne pas la desactiver sans diagnostic. `.ops/current-image`, `previous-image`, `pending-image` et `last-backup` permettent de retrouver les versions et preuves locales. `bash ops/poste rollback` refuse les schemas differents et ne restaure jamais la base implicitement. En cas de migration incompatible, restaurer la sauvegarde pre-deploiement dans une stack isolee et valider avant promotion manuelle; conserver les volumes originaux. Pour une installation deja existante avant cette version, faire une sauvegarde et appliquer la migration 003 avec les anciens workers arretes avant d'utiliser l'operateur.

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

La vue **A valider** permet de selectionner jusqu'a 50 candidatures, generer les CV/lettres et preparer les formulaires en lot. Chaque PDF doit etre consulte puis approuve individuellement dans Documents. La confirmation d'envoi affiche les exclusions; chaque resultat reste visible dans Operations recentes. Le mode `review_required` est le defaut, y compris pour les connecteurs existants. L'autorisation de soumission expire apres 24 heures, est consommee avant le clic et depend du profil, du contenu de l'offre, de la configuration et des documents exacts. Une modification l'invalide. Aucun report implicite au lendemain. Le mode `automatic` reste une option explicite soumise aux memes seuils et limites.

Configuration initiale affiche les integrations disponibles et les variables requises sans exposer les secrets. Les tests sont demandes explicitement : IMAP ouvre la boite en lecture seule, notification de test sur le canal choisi et appel IA minimal debite du budget conservateur (IA active requise). Les diagnostics sont expurges. Enrichir utilise uniquement un connecteur HTML autorise et ses domaines declares, conserve le contenu brut et la provenance puis recalcule le score; les documents cibles perdent leur approbation si l'offre change.

La machine d'etats protege contre les reprises : une interruption apres la reservation de soumission donne `unknown`, jamais un nouvel envoi. Verifier la plateforme puis utiliser les boutons de resolution avec une preuve. Les transitions Kanban ne peuvent contourner ce verrou. Un connecteur modifie exige une nouvelle simulation. Activer la soumission ou approuver un document ne declenche un envoi sans validation que pour un connecteur en mode `automatic`. Pour ouvrir une session dediee sur un poste prive : `npm run sessions -- identifiant` avec les memes DATABASE_URL/SESSIONS_DIR ; fermer le navigateur apres connexion. Ne pas ouvrir simultanement ce profil avec le runner. Le serveur headless n'expose aucun bureau distant.

## Exploitation et sauvegardes

Les workers publient un heartbeat ; le dashboard montre leur etat, les erreurs et la livraison des notifications. Une erreur structurelle repetee trois fois suspend le connecteur ; un challenge/restriction le suspend immediatement. Collecte HTTP toutes les six heures, execution serialisee par connecteur, backoff et respect de Retry-After. Arret global pour collecte, IA, notifications et runner ; une soumission deja partie doit finir sa verification.

Sauvegarde ponctuelle : `bash ops/poste backup`. Le dump PostgreSQL, documents et sessions sont chiffres avant upload; une lecture de controle precede toute purge. Retention de sept copies quotidiennes et quatre copies hebdomadaires (dimanche) hors serveur; sept copies locales. Une erreur laisse les traitements suspendus et ne purge aucune ancienne archive avant confirmation de l'upload. Le dashboard affiche le dernier resultat. Installer `ops/poste-backup.service` et `ops/poste-backup.timer` dans `/etc/systemd/system`, adapter chemins/utilisateur si necessaire, puis `sudo systemctl enable --now poste-backup.timer`. L'ancien conteneur backup est ponctuel et ne remplace pas cette procedure de gel et d'upload.

Chaque mois, telecharger une archive et son `.sha256`, utiliser la meme image que lors de sa capture, puis restaurer dans des volumes neufs avec un port et un repertoire d'etat distincts :

Executer cet exercice sur une autre machine Linux de confiance : la cle privee ne doit jamais etre placee sur le serveur de production. Le digest de capture est aussi conserve dans `image-digest.txt` a l'interieur de l'archive chiffree.

```bash
POSTE_PROJECT=poste-restore-monthly POSTE_STATE_DIR=.ops-restore POSTE_PORT=3002 APP_ORIGIN=http://localhost:3002 \
  POSTE_IMAGE=ghcr.io/garder500/job-aggregator@sha256:DIGEST \
  bash ops/poste restore /chemin/poste-ARCHIVE.tar.age /chemin/cle-privee.age
```

La restauration refuse une base non vide, laisse la maintenance active et ne lance pas les workers. Ouvrir le dashboard par tunnel SSH vers 3002 et verifier une offre et son PDF. Sur la stack de production, enregistrer uniquement apres verification reelle : `bash ops/poste record-restore verified`. Le test automatise verifie le dump/restore PostgreSQL; l'exercice complet chiffre reste a effectuer avec vos cles. Ne jamais conserver la cle privee dans le depot ni sur le serveur de production.

## API des nouveaux workflows

Routes authentifiees : GET `/api/setup`, POST `/api/diagnostics/:integration` (`imap|notifications|ai`), POST `/api/jobs/:id/enrich` (`connectorId`), GET `/api/review`, POST `/api/batches` (`action: cv|letter|prepare|submit`, `applicationIds`), GET `/api/operations` et `/api/operations/:id`. Pour `submit`, transmettre aussi `reviewTokens`, une correspondance candidature/jeton issue de la revue : une modification entre revue et confirmation exclut la ligne. Les nouveaux POST exigent `Idempotency-Key` (8 a 120 caracteres) et l'origine exacte. Meme cle et meme demande renvoient la meme operation; reutilisation avec une autre demande refusee. Les lots renvoient un identifiant et des resultats individuels, sans approbation documentaire collective. Les journaux ne contiennent ni secret ni CV integral.

## Verification

`npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build`, puis `npm run test:e2e`. Les tests d'integration et navigateur demarrent leurs propres bases et services, sans utiliser vos donnees ni credentials externes. `pg_dump` et `pg_restore` de la meme version majeure que la base doivent etre dans PATH pour le test d'integration (ou definir `PG_BIN`). Les preuves du runner comprennent des evenements, metadonnees et captures avec champs et identite masques, conservees sept jours ; aucune trace brute contenant le CV ou des cookies n'est conservee.

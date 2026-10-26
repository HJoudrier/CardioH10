# CardioH10

Application web (HTML / CSS / JavaScript, sans dépendance ni build) pour enregistrer un ECG avec une ceinture **Polar H10** en Bluetooth et produire un tracé au format cardiologique :

- papier millimétré (1 mm / 5 mm), **25 mm/s**, **10 mm/mV**, impulsion d'étalonnage 1 mV sur la première ligne de chaque page ; au début des lignes suivantes, rappel en grisé de la dernière seconde de la ligne du dessus pour lire la continuité du tracé ;
- en-tête : nom, date et heure (HH:MM:SS), durée, FC moyenne / min / max, HRV (RMSSD et SDNN) ;
- pied de page : date et heure de l'enregistrement ;
- export **PNG** (A4 paysage, 300 dpi, résolution incluse dans le fichier) et **PDF** vectoriel A4 paysage, imprimable à l'échelle 1:1 (10 s par ligne, 3 lignes = 30 s par page, pages supplémentaires au-delà) ;
- sauvegarde locale des tracés (IndexedDB), export / import JSON ;
- **partage en direct à distance** par lien ou QR code (voir plus bas).

## Utilisation

Web Bluetooth impose un navigateur **Chrome ou Edge** (ordinateur ou Android) et une page servie en **HTTPS** ou sur **localhost** (Safari / iOS et Firefox ne sont pas compatibles).

L'application est statique, sans serveur applicatif : publiez-la telle quelle (GitHub Pages) ou ouvrez `index.html` / servez le dossier avec n'importe quel serveur de fichiers.

1. Humidifier les électrodes de la ceinture et la porter ; fermer les autres applications connectées au H10 (Polar Beat, etc.).
2. « Connecter le Polar H10 », choisir le capteur ; le tracé s'affiche en direct.
3. Saisir le nom du patient et choisir la durée de la **mémoire tampon** (10 s à 5 min, ou sans limite) : dès la connexion, elle se remplit (barre de progression) puis garde en continu les dernières secondes reçues.
4. « Enregistrer » sauvegarde le contenu de la mémoire tampon sur l'appareil **sans interrompre l'acquisition** : on peut enregistrer à nouveau à tout moment (par exemple à chaque symptôme). Le tracé s'affiche dans le rapport : « Exporter PNG », « Exporter PDF ».

Sans capteur, « Mode démonstration » génère un ECG simulé pour tester l'application.

### Plein écran en paysage

Le bouton ⛶ à droite de la fréquence cardiaque affiche le tracé en direct en plein écran, en paysage (aussi chez le spectateur). Le papier remplit l'écran à la même échelle (25 mm/s, 10 mm/mV, 10 s visibles) ; la fréquence cardiaque et le remplissage de la mémoire tampon restent affichés.

- **Android (Chrome, Edge) :** la page passe en plein écran et l'écran est verrouillé en paysage.
- **iPhone :** Safari ne permet pas le plein écran d'une page ; le tracé occupe toute la fenêtre et, si le téléphone reste en portrait, il pivote de 90° (tourner le téléphone vers la gauche pour le lire).
- Pour quitter : le même bouton, la touche Échap ou, sur Android, le geste retour.

### Partager le tracé en direct (QR code)

« Partager en direct (QR code) » affiche un lien et un QR code. La personne qui l'ouvre voit le tracé et la fréquence cardiaque en direct dans son navigateur, sans rien installer (page en lecture seule : pas d'enregistrement ni d'export).

- Les mesures passent **directement d'un navigateur à l'autre** (WebRTC, chiffré). Aucun serveur ne les stocke ni ne les relaie.
- Un serveur de mise en relation public (PeerJS) et des serveurs STUN publics sont utilisés pour établir la connexion : ils voient l'identifiant aléatoire du partage et les adresses IP, pas les mesures.
- Le lien contient un identifiant aléatoire non devinable : **toute personne qui possède le lien peut regarder**. « Arrêter le partage » le rend inutilisable.
- Le nom du patient n'est transmis que si la case « Afficher le nom du patient chez le spectateur » est cochée.
- Gardez la page du capteur ouverte et au premier plan pendant le partage.
- Sur certains réseaux (pare-feu d'entreprise, NAT strict), la connexion directe peut être impossible : il faudrait alors ajouter un serveur TURN. Les options PeerJS (serveur de mise en relation, TURN) se règlent avec `window.CARDIOH10_PEER`, à définir avant `js/share.js`.

### Veille, changement d'onglet, coupures

- **Changement d'onglet / fenêtre en arrière-plan :** la mémoire tampon continue de se remplir (la réception Bluetooth ne dépend pas de l'affichage ; l'application garde en plus un verrou « Web Locks » pour que Chrome ne gèle pas l'onglet).
- **Veille de l'écran :** tant qu'un capteur est connecté ou qu'un partage est actif, l'application demande à garder l'écran allumé (case « Garder l'écran allumé »). Attention : si l'écran est **verrouillé** (bouton d'alimentation) ou si le navigateur est fermé / mis en arrière-plan sur téléphone, Android peut suspendre la page et le navigateur ne garantit rien. Posez le téléphone écran allumé, branché si possible.
- **Perte de liaison** (éloignement, parasite) : reconnexion automatique pendant ~1 minute ; la mémoire tampon continue et la coupure apparaît en ligne plate sur le tracé. Si le capteur ne revient pas, la mémoire tampon reste disponible : « Enregistrer » la sauvegarde encore.
- **Page fermée ou tuée capteur connecté :** la mémoire tampon est copiée toutes les 10 s ; à la réouverture elle s'affiche dans le rapport (« Sauvegarder » pour la conserver).

### Impression à l'échelle 1:1

Ouvrir le PDF, papier **A4 paysage**, échelle **100 % / Taille réelle** (surtout pas « Ajuster à la page »). Vérifier : 5 grands carreaux = 25 mm = 1 s.

## Détails techniques

- ECG : service PMD de Polar (`FB005C80-…`), 130 Hz, 14 bits, échantillons en µV.
- FC et HRV : calculées à partir des intervalles RR fournis par le capteur (service Heart Rate) ; à défaut, par détection des ondes R sur l'ECG. Les intervalles aberrants (hors 300–2000 ms ou à plus de 35 % de la médiane locale) sont écartés.
- Filtre optionnel 0,5–40 Hz à phase nulle appliqué à l'affichage et aux exports (le signal brut est conservé).

## Avertissement

Capteur grand public, dérivation unique : ce tracé n'est pas un dispositif médical et ne remplace pas un ECG 12 dérivations.

```
index.html        interface
css/style.css
js/polar.js       Bluetooth H10 + source de démonstration
js/analysis.js    filtres, détection R, FC / HRV
js/render.js      mise en page du rapport (mm) + rendu canvas
js/pdf.js         générateur PDF vectoriel
js/storage.js     IndexedDB + JSON
js/share.js       partage en direct (WebRTC) + QR code
vendor/           PeerJS 1.5.4 et qrcode-generator 1.4.4 (MIT)
js/app.js         interface et exports
```

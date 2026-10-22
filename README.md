# CardioH10

Application web (HTML / CSS / JavaScript, sans dépendance ni build) pour enregistrer un ECG avec une ceinture **Polar H10** en Bluetooth et produire un tracé au format cardiologique :

- papier millimétré (1 mm / 5 mm), **25 mm/s**, **10 mm/mV**, impulsion d'étalonnage 1 mV ;
- en-tête : nom, date, durée, FC moyenne / min / max, HRV (RMSSD et SDNN) ;
- pied de page : date et heure de l'enregistrement ;
- export **PNG** (A4 paysage, 300 dpi, résolution incluse dans le fichier) et **PDF** vectoriel A4 paysage, imprimable à l'échelle 1:1 (10 s par ligne, 3 lignes = 30 s par page, pages supplémentaires au-delà) ;
- sauvegarde locale des tracés (IndexedDB), export / import JSON.

## Utilisation

Web Bluetooth impose un navigateur **Chrome ou Edge** (ordinateur ou Android) et une page servie en **HTTPS** ou sur **localhost** (Safari / iOS et Firefox ne sont pas compatibles).

```bash
python3 -m http.server 8000     # puis ouvrir http://localhost:8000
```

L'application est statique : elle peut aussi être publiée telle quelle (GitHub Pages, par exemple).

1. Humidifier les électrodes de la ceinture et la porter ; fermer les autres applications connectées au H10 (Polar Beat, etc.).
2. « Connecter le Polar H10 », choisir le capteur ; le tracé s'affiche en direct.
3. Saisir le nom du patient, choisir la durée, « Enregistrer ».
4. Le rapport s'affiche : « Sauvegarder », « Exporter PNG », « Exporter PDF ».

Sans capteur, « Mode démonstration » génère un ECG simulé pour tester l'application.

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
js/app.js         interface et exports
```

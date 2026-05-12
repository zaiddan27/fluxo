# Fluxo Web App

A single-page tool for gap-filling Bulacan urban water-demand records.

## Usage

1. Open `index.html` in a modern browser (Chrome, Edge, Firefox, Safari).
   No server needed - it's a static page.
2. Drag-and-drop or upload your CSV / XLSX file in the same format as the
   raw Bulacan urban files (year, month, municipality columns in m^3).
3. The app de-staircases, computes per-capita demand using bundled PSA
   census data, and backcasts missing pre-observation years using
   Doña Remedios Trinidad as the long-record template
   (station-substitution / MOVE method, Hirsch 1982).
4. Download the filled CSV, copy table to clipboard, or download an
   HTML report with full methodology and references.

## Files

- `index.html` - the entire app (HTML + CSS + JS, single file)
- `clsu_logo.jpg` - branding

## Supported municipalities

22 Bulacan LGUs: Doña Remedios Trinidad, Norzagaray, Angat, Bulacan/Bulakan,
Bustos, Plaridel, San Rafael, City of Malolos, Hagonoy, Baliwag, Calumpit,
Guiguinto, Pandi, Balagtas, Bocaue, Marilao, Meycauayan City, Obando,
San Jose del Monte City, Santa Maria, San Ildefonso, San Miguel.

Column headers in the uploaded file should match these names (case-insensitive,
common aliases like "DRT" and "Bulakan" are recognized).

## Hosting

To put this online (e.g. on GitHub Pages):
1. Push the `webapp/` folder to the repo.
2. Enable GitHub Pages: Settings -> Pages -> Source: `main` branch, `/webapp` folder.
3. Visit `https://<your-username>.github.io/fluxo/`.

All computation runs locally in the browser - no data leaves the user's device.

## Privacy

The app uses only two CDN libraries (SheetJS and PapaParse for file parsing).
Uploaded files are processed entirely in browser memory - nothing is uploaded
to any server.

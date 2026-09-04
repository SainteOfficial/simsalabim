# Fahrzeug-Mängel-Scanner

Chrome-Extension, die auf Fahrzeugseiten automatisch **Fahrzeug PDF** und **Zustandsbericht**
findet, die PDFs herunterlädt, ausliest und per KI (OpenRouter) alle Mängel in einem kleinen
Fenster oben rechts anzeigt.

<p><img src="docs/panel.png" width="380" alt="Panel im hellen Modus">
<img src="docs/panel-dark.png" width="380" alt="Panel im dunklen Modus"></p>

## Was die Extension macht

1. **Erkennen** – findet auf jeder Seite Links wie „Fahrzeug PDF", „Zustandsbericht",
   „Appraisal", „Gutachten", „Prüfbericht" oder beliebige `.pdf`-Links und liest nebenbei
   FIN, Kilometerstand und Erstzulassung aus der Seite.
   Ein Panel erscheint nur, wenn die Seite wirklich nach einem Fahrzeug aussieht – kein
   Aufpoppen auf Blogs oder Preislisten.
2. **Laden** – holt die PDFs zuerst im Seitenkontext (nutzt also die bestehende Anmeldung
   beim Händler-/Auktionsportal) und fällt bei CORS-Blockaden auf den Hintergrunddienst zurück.
3. **Lesen** – extrahiert den Text lokal mit **pdf.js**, spaltenerhaltend, damit Tabellen aus
   Zustandsberichten erhalten bleiben. Steckt kein Text im PDF (reiner Scan), werden die Seiten
   automatisch als Bilder gerendert und per Bilderkennung ausgewertet.
4. **Analysieren** – ein einziger OpenRouter-Aufruf mit **Structured Output** (JSON-Schema),
   `temperature: 0`. Das Modell darf nichts erfinden und muss zu jedem Mangel ein wörtliches
   Zitat als Beleg liefern.
5. **Anzeigen** – Panel oben rechts: Gesamtzustand, Mängel nach Schwere sortiert und filterbar,
   TÜV-Relevanz, Kosten laut Dokument, Reifenprofil, Seitenzahl und Beleg-Zitat pro Mangel.
   Verschiebbar, ein-/ausklappbar, hell und dunkel.

## Installation

1. Repository herunterladen oder klonen.
2. In Chrome `chrome://extensions` öffnen, **Entwicklermodus** einschalten.
3. **Entpackte Erweiterung laden** → den Ordner `extension/` auswählen.
4. Die Optionsseite öffnet sich automatisch. Dort den OpenRouter-API-Key eintragen
   (erstellen auf [openrouter.ai/keys](https://openrouter.ai/keys)) und auf **Speichern** klicken.
   Mit **Testen** lässt sich die Verbindung sofort prüfen.

Der Key wird ausschließlich lokal in `chrome.storage.local` gespeichert und nur an OpenRouter
gesendet. Fahrzeugseiten und PDFs gehen an keinen anderen Server.

Danach passiert alles von selbst: Fahrzeugseite öffnen → Panel erscheint → Mängel stehen da.

## Kosten und Modellwahl

**Ja, GPT-4o mini reicht für Text-PDFs.** Zustandsberichte sind Fließtext und Tabellen; die
Arbeit macht ohnehin pdf.js, das Modell muss nur strukturieren. Mit `temperature: 0` und
JSON-Schema ist die Ausgabe stabil.

| Fall | Modell | Kosten pro Fahrzeug |
| --- | --- | --- |
| PDF mit Textlayer (Normalfall) | `openai/gpt-4o-mini` | rund **0,1 Cent** |
| Gescanntes PDF (Bilderkennung) | `openai/gpt-4o-mini` | ca. 2–4 Cent (Bilder kosten viele Tokens) |
| Gescanntes PDF, günstiger + besseres OCR | `google/gemini-2.0-flash-001` | Bruchteil davon |

Empfehlung: Textmodell auf GPT-4o mini lassen, für gescannte PDFs in den Optionen
Gemini 2.0 Flash als Scan-Modell wählen.

Zusätzlich spart die Extension automatisch:

- **Cache** – jedes PDF wird über seinen Hash erkannt; dasselbe Dokument wird nie zweimal
  bezahlt (Footer zeigt dann „Cache").
- **Intelligentes Kürzen** – überlange Dokumente werden nicht stumpf abgeschnitten, sondern
  Absätze mit Mängel-Signalwörtern (Schaden, Rost, Profiltiefe, Beanstandung …) bevorzugt behalten.
- **Ein Aufruf statt mehrerer** – Fahrzeug-PDF und Zustandsbericht gehen gemeinsam in eine Anfrage.
- **Bilder nur im Notfall** – die teure Bilderkennung greift ausschließlich, wenn wirklich kein
  Text im PDF steckt.

## Einstellungen

| Einstellung | Bedeutung |
| --- | --- |
| API-Key / API-Endpunkt | OpenRouter-Zugang; Endpunkt nur ändern, wenn ein eigener Proxy genutzt wird |
| Modell / Scan-Modell | getrennte Modelle für Text-PDFs und gescannte PDFs |
| Automatisch starten | Analyse startet ohne Klick, sobald eine Fahrzeugseite erkannt wird |
| Bilderkennung + max. Seiten | Fallback für Scans und dessen Kostendeckel |
| Max. Zeichen an die KI | Obergrenze pro Analyse (Standard 120.000) |
| Sprache der Ausgabe | Deutsch oder Englisch |
| Modus / Domains | überall, nur auf bestimmten Domains oder überall außer bestimmten Domains |
| Zusätzliche Stichwörter | für ungewöhnlich benannte Links |
| Cache | Größe ansehen und leeren |

Über das Symbol in der Toolbar lässt sich eine Seite auch manuell prüfen.

## Aufbau

```
extension/
  manifest.json            Manifest V3
  src/
    background.js          Service Worker: Ablaufsteuerung, Download-Fallback, Cache
    content/content.js     Erkennung, PDF-Download im Seitenkontext, Panel (Shadow DOM)
    content/panel.css      Panel-Design, hell/dunkel
    offscreen/             pdf.js-Textextraktion + Seitenrendering (SW hat kein DOM)
    options/, popup/       Einstellungen und Toolbar-Popup
    lib/config.js          Defaults, Modelle, Preise
    lib/prompt.js          System-Prompt, JSON-Schema, intelligentes Kürzen
    lib/openrouter.js      API-Client mit Retry, Timeout, Kostenermittlung
    lib/cache.js           Text- und Ergebnis-Cache (LRU)
  vendor/pdfjs/            pdf.js 3.11.174 (Apache-2.0), lokal eingebunden
test/
  e2e.mjs                  End-to-End-Test mit echtem Chromium
  fixtures/                Testseiten, Test-PDFs, Mock-Antwort
```

## Tests

```bash
npm install -D playwright        # Chromium wird benötigt
node test/e2e.mjs
```

Der Test startet einen lokalen Fixture-Server und einen OpenRouter-Mock, lädt die Extension
ungepackt in Chromium und prüft 23 Punkte: Erkennung, Fehlalarm-Freiheit, PDF-Download,
Textextraktion inklusive Tabellenspalten, Prompt-Inhalt, Structured Output, Panel-Interaktion,
Cache-Treffer ohne zweiten API-Aufruf und den Bilderkennungs-Pfad für gescannte PDFs.

Ist Chromium an einem anderen Ort installiert: `CHROME_PATH=/pfad/zu/chrome node test/e2e.mjs`.

## Grenzen

- PDFs, die sich nur über ein Formular (POST) oder reines JavaScript herunterladen lassen,
  kann die Extension nicht abrufen; sie meldet das im Panel.
- Passwortgeschützte PDFs werden nicht geöffnet.
- Die Auswertung ist so gut wie das Dokument: Was nicht im Zustandsbericht steht, taucht auch
  nicht im Panel auf. Das Modell soll nichts ergänzen – deshalb steht bei jedem Mangel das
  Zitat aus dem PDF darunter.

/**
 * Prompt + JSON-Schema für die Mängel-Extraktion.
 * PROMPT_VERSION geht in den Cache-Key ein: Prompt ändern => Cache wird ungültig.
 */

export const PROMPT_VERSION = 3;

export const DEFECT_SCHEMA = {
  name: 'fahrzeug_maengel',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'vehicle',
      'report_found',
      'overall_condition',
      'summary',
      'total_estimated_repair_cost_eur',
      'defects',
      'tires',
      'missing_info',
      'confidence'
    ],
    properties: {
      vehicle: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'vin', 'mileage_km', 'first_registration', 'report_date'],
        properties: {
          title: { type: ['string', 'null'] },
          vin: { type: ['string', 'null'] },
          mileage_km: { type: ['number', 'null'] },
          first_registration: { type: ['string', 'null'] },
          report_date: { type: ['string', 'null'] }
        }
      },
      report_found: {
        type: 'boolean',
        description: 'true, wenn das Dokument tatsächlich Zustands-/Mängelangaben enthält.'
      },
      overall_condition: {
        type: 'string',
        enum: ['sehr gut', 'gut', 'befriedigend', 'mangelhaft', 'unbekannt']
      },
      summary: {
        type: 'string',
        description: 'Max. 2 Sätze: Gesamteindruck und die gravierendsten Punkte.'
      },
      total_estimated_repair_cost_eur: {
        type: ['number', 'null'],
        description: 'Nur ausfüllen, wenn im Dokument Kosten genannt sind (Summe). Sonst null.'
      },
      defects: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'title',
            'description',
            'area',
            'category',
            'severity',
            'estimated_cost_eur',
            'affects_roadworthiness',
            'source_page',
            'quote'
          ],
          properties: {
            title: { type: 'string', description: 'Kurzbezeichnung, max. 6 Wörter.' },
            description: { type: 'string', description: 'Was genau ist beschädigt/defekt.' },
            area: {
              type: 'string',
              description: 'Verbaute Stelle, z.B. "Stoßfänger vorne links", "Motorraum".'
            },
            category: {
              type: 'string',
              enum: [
                'karosserie',
                'lack',
                'glas',
                'reifen',
                'raeder',
                'innenraum',
                'technik',
                'motor',
                'getriebe',
                'fahrwerk',
                'bremsen',
                'elektrik',
                'ausstattung',
                'dokumente',
                'sonstiges'
              ]
            },
            severity: {
              type: 'string',
              enum: ['kritisch', 'mittel', 'gering', 'hinweis'],
              description:
                'kritisch = sicherheitsrelevant/teuer, mittel = Reparatur noetig, gering = kosmetisch, hinweis = reine Info.'
            },
            estimated_cost_eur: {
              type: ['number', 'null'],
              description: 'Nur wenn im Dokument genannt, sonst null. Nichts schätzen.'
            },
            affects_roadworthiness: {
              type: 'boolean',
              description: 'true, wenn HU/TÜV-relevant bzw. verkehrssicherheitsrelevant.'
            },
            source_page: { type: ['integer', 'null'], description: 'PDF-Seite, falls erkennbar.' },
            quote: {
              type: ['string', 'null'],
              description: 'Wörtliches Zitat aus dem Dokument als Beleg, max. 160 Zeichen.'
            }
          }
        }
      },
      tires: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['position', 'dimension', 'tread_mm', 'note'],
          properties: {
            position: { type: 'string', description: 'z.B. "VL", "VR", "HL", "HR"' },
            dimension: { type: ['string', 'null'] },
            tread_mm: { type: ['number', 'null'] },
            note: { type: ['string', 'null'] }
          }
        }
      },
      missing_info: {
        type: 'array',
        items: { type: 'string' },
        description: 'Wichtige Angaben, die im Dokument fehlen (z.B. "keine Reifenprofiltiefe").'
      },
      confidence: {
        type: 'number',
        description: '0..1 - wie sicher ist die Extraktion (schlechter Scan => niedrig).'
      }
    }
  }
};

const LANG_LABEL = { de: 'Deutsch', en: 'English' };

export function systemPrompt(lang = 'de') {
  return [
    'Du bist ein erfahrener Kfz-Sachverständiger und wertest Fahrzeugdokumente aus',
    '(Zustandsberichte, Gutachten, Fahrzeug-Datenblätter, Auktions-Exposés).',
    '',
    'Aufgabe: Extrahiere ALLE dokumentierten Mängel, Schäden und Auffälligkeiten.',
    '',
    'Harte Regeln:',
    '1. Nur Fakten aus dem Dokument. Nichts hinzuerfinden, nichts aus Fahrzeugmodell/Alter ableiten.',
    '2. Kosten nur übernehmen, wenn sie explizit im Dokument stehen. Sonst null.',
    '3. Jeder Mangel bekommt ein wörtliches Zitat als Beleg ("quote").',
    '4. Doppelte Einträge zusammenfassen (gleicher Schaden auf mehreren Seiten = ein Eintrag).',
    '5. Reine Ausstattungslisten, Werbetexte, AGB und Händlerdaten sind KEINE Mängel.',
    '6. Positive Aussagen ("keine Beanstandung", "i.O.") sind KEINE Mängel.',
    '7. Reifen mit Profiltiefe unter 3 mm als Mangel (severity "mittel"), unter 1,6 mm als "kritisch".',
    '8. Wenn das Dokument keine Zustandsangaben enthält: report_found=false und defects=[].',
    '9. Sortiere defects nach Schwere: kritisch, mittel, gering, hinweis.',
    '',
    `Sprache aller Freitexte: ${LANG_LABEL[lang] || 'Deutsch'}.`,
    'Antworte ausschließlich mit dem geforderten JSON.'
  ].join('\n');
}

export function userPrompt({ pageContext, documents }) {
  const parts = [];
  if (pageContext && Object.keys(pageContext).length) {
    parts.push('### Kontext von der Webseite (kann unvollständig sein)');
    parts.push(
      Object.entries(pageContext)
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n')
    );
    parts.push('');
  }
  documents.forEach((doc, i) => {
    parts.push(`### Dokument ${i + 1}: ${doc.label || doc.name || 'PDF'}`);
    if (doc.pages) parts.push(`(${doc.pages} Seiten${doc.truncated ? ', gekürzt' : ''})`);
    parts.push('"""');
    parts.push(doc.text);
    parts.push('"""');
    parts.push('');
  });
  parts.push('Extrahiere jetzt die Mängel als JSON gemäß Schema.');
  return parts.join('\n');
}

export function visionUserPrompt(pageContext) {
  const ctx = Object.entries(pageContext || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  return [
    'Das PDF enthält keinen auslesbaren Text (Scan). Anbei die Seiten als Bilder.',
    'Lies sie sorgfältig (auch Ankreuzfelder, Tabellen und handschriftliche Notizen)',
    'und extrahiere die Mängel als JSON gemäß Schema.',
    ctx ? `\n### Kontext von der Webseite\n${ctx}` : ''
  ].join('\n');
}

/**
 * Kürzt zu langen Text intelligent: Absätze mit Mängel-Signalwörtern werden
 * bevorzugt behalten, der Rest fällt weg. Spart Tokens = Geld.
 */
const SIGNAL_WORDS = [
  'mangel', 'mängel', 'maengel', 'schaden', 'schäden', 'defekt', 'beschädig', 'kratzer',
  'delle', 'beule', 'rost', 'korrosion', 'riss', 'undicht', 'verschleiß', 'verschleiss',
  'abgefahren', 'profiltiefe', 'bremse', 'kupplung', 'motor', 'getriebe', 'öl', 'oel',
  'warnleuchte', 'fehlerspeicher', 'unfall', 'lackier', 'nachlackier', 'steinschlag',
  'reparatur', 'instandsetzung', 'kosten', 'tüv', 'tuev', 'hu ', 'au ', 'zustand',
  'bewertung', 'note', 'beanstandung', 'funktion', 'fehlt', 'fehlend', 'ersatz',
  'damage', 'defect', 'scratch', 'dent', 'rust', 'wear', 'repair', 'condition'
];

export function condenseText(text, maxChars) {
  if (!text) return { text: '', truncated: false };
  const clean = text
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  if (clean.length <= maxChars) return { text: clean, truncated: false };

  const blocks = clean.split(/\n\s*\n/);
  const scored = blocks.map((b, idx) => {
    const lower = b.toLowerCase();
    let score = 0;
    for (const w of SIGNAL_WORDS) if (lower.includes(w)) score += 2;
    if (/\d+[.,]?\d*\s*(mm|eur|EUR)/.test(b)) score += 2;
    if (idx < 4) score += 3; // Kopf des Dokuments (Fahrzeugdaten) immer behalten
    return { idx, block: b, score };
  });

  const keep = [];
  let used = 0;
  for (const item of scored.slice().sort((a, b) => b.score - a.score || a.idx - b.idx)) {
    if (used + item.block.length > maxChars) continue;
    keep.push(item);
    used += item.block.length + 2;
  }
  keep.sort((a, b) => a.idx - b.idx);
  return {
    text: keep.map((k) => k.block).join('\n\n') + '\n\n[... Dokument gekuerzt ...]',
    truncated: true
  };
}

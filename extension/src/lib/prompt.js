/**
 * Prompts + JSON-Schemata.
 *
 * Grundsatz: Es wird NICHTS weggeworfen. Passt ein Dokument nicht in einen
 * Aufruf, wird es an Seitengrenzen in Chunks zerlegt, jeder Chunk vollständig
 * ausgewertet und die Ergebnisse anschließend zusammengeführt.
 *
 * PROMPT_VERSION geht in den Cache-Key ein: Prompt ändern => Cache wird ungültig.
 */

export const PROMPT_VERSION = 6;

/* ------------------------------------------------------------- Bausteine */

const VEHICLE_PROPS = {
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
};

const DEFECT_ITEM = {
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
        'karosserie', 'lack', 'glas', 'reifen', 'raeder', 'innenraum', 'technik',
        'motor', 'getriebe', 'fahrwerk', 'bremsen', 'elektrik', 'ausstattung',
        'dokumente', 'sonstiges'
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
};

const TIRE_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'dimension', 'tread_mm', 'note'],
  properties: {
    position: { type: 'string', description: 'z.B. "VL", "VR", "HL", "HR"' },
    dimension: { type: ['string', 'null'] },
    tread_mm: { type: ['number', 'null'] },
    note: { type: ['string', 'null'] }
  }
};

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: [
    'recommendation',
    'score',
    'headline',
    'reasons',
    'deal_breakers',
    'negotiation_points',
    'before_first_drive',
    'repair_budget_min_eur',
    'repair_budget_max_eur',
    'price_assessment'
  ],
  properties: {
    recommendation: {
      type: 'string',
      enum: ['kaufen', 'kaufen_mit_vorbehalt', 'nachverhandeln', 'finger_weg', 'unklar'],
      description:
        'kaufen = keine relevanten Mängel; kaufen_mit_vorbehalt = kleinere Mängel, kalkulierbar; ' +
        'nachverhandeln = deutliche Mängel, Preis muss runter; finger_weg = schwere/teure oder ' +
        'sicherheitskritische Mängel bzw. Unfall-/Rostverdacht; unklar = Datenlage reicht nicht.'
    },
    score: {
      type: ['integer', 'null'],
      description:
        'Zustands-Score 0-100 allein aus dem Dokument. 100 = mängelfrei. ' +
        'null, wenn die Datenlage für ein Urteil nicht reicht (recommendation "unklar") - ' +
        'eine 0 hieße "Totalschaden" und wäre dort falsch.'
    },
    headline: {
      type: 'string',
      description:
        'Ein Satz, der die Empfehlung auf den Punkt bringt. Bei "unklar": welche Angabe fehlt, ' +
        'damit ein Urteil möglich wäre. Nie leer lassen.'
    },
    reasons: {
      type: 'array',
      items: { type: 'string' },
      description: '2-4 kurze Begründungen, je auf einen konkreten Befund gestützt.'
    },
    deal_breakers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Befunde, die für sich genommen gegen den Kauf sprechen. Leer, wenn keine.'
    },
    negotiation_points: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['point', 'amount_eur'],
        properties: {
          point: { type: 'string' },
          amount_eur: {
            type: ['number', 'null'],
            description: 'Nur wenn im Dokument beziffert, sonst null.'
          }
        }
      },
      description: 'Konkrete Hebel für die Preisverhandlung, teuerster zuerst.'
    },
    before_first_drive: {
      type: 'array',
      items: { type: 'string' },
      description: 'Was vor der ersten Fahrt gemacht werden muss (Verkehrssicherheit, HU).'
    },
    repair_budget_min_eur: {
      type: ['number', 'null'],
      description: 'Summe der im Dokument bezifferten Kosten. null, wenn keine genannt.'
    },
    repair_budget_max_eur: {
      type: ['number', 'null'],
      description: 'Summe inkl. der Positionen ohne Betrag, falls das Dokument eine Spanne nennt. Sonst null.'
    },
    price_assessment: {
      type: ['string', 'null'],
      description:
        'Nur ausfüllen, wenn im Kontext ein Preis steht: Einordnung des Preises gegenüber dem ' +
        'dokumentierten Zustand. Ohne Preisangabe null.'
    }
  }
};

/** Vollständiges Schema: Mängel + Kaufempfehlung in einem Aufruf. */
export const DEFECT_SCHEMA = {
  name: 'fahrzeug_maengel',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'vehicle', 'report_found', 'overall_condition', 'summary',
      'total_estimated_repair_cost_eur', 'defects', 'tires', 'missing_info',
      'confidence', 'verdict'
    ],
    properties: {
      vehicle: VEHICLE_PROPS,
      report_found: {
        type: 'boolean',
        description: 'true, wenn das Dokument tatsächlich Zustands-/Mängelangaben enthält.'
      },
      overall_condition: {
        type: 'string',
        enum: ['sehr gut', 'gut', 'befriedigend', 'mangelhaft', 'unbekannt']
      },
      summary: { type: 'string', description: 'Max. 2 Sätze: Gesamteindruck und die gravierendsten Punkte.' },
      total_estimated_repair_cost_eur: {
        type: ['number', 'null'],
        description: 'Nur ausfüllen, wenn im Dokument Kosten genannt sind (Summe). Sonst null.'
      },
      defects: { type: 'array', items: DEFECT_ITEM },
      tires: { type: 'array', items: TIRE_ITEM },
      missing_info: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Wichtige Angaben, die im Dokument fehlen (z.B. "keine Reifenprofiltiefe", ' +
          '"keine Angabe zu Unfallschäden"). Das ist die Begründung dafür, wie weit die ' +
          'Einschätzung trägt - bei recommendation "unklar" hier nicht leer lassen.'
      },
      confidence: { type: 'number', description: '0..1 - wie sicher ist die Extraktion.' },
      verdict: VERDICT
    }
  }
};

/** Schema für einen einzelnen Chunk: reine Extraktion, noch kein Urteil. */
export const CHUNK_SCHEMA = {
  name: 'fahrzeug_maengel_chunk',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['vehicle', 'report_found', 'defects', 'tires', 'missing_info', 'confidence'],
    properties: {
      vehicle: VEHICLE_PROPS,
      report_found: { type: 'boolean' },
      defects: { type: 'array', items: DEFECT_ITEM },
      tires: { type: 'array', items: TIRE_ITEM },
      missing_info: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number' }
    }
  }
};

/** Schema für den Zusammenführungs-Schritt über alle Chunks. */
export const SYNTHESIS_SCHEMA = {
  name: 'fahrzeug_bewertung',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'overall_condition', 'summary', 'total_estimated_repair_cost_eur',
      'duplicate_indices', 'verdict'
    ],
    properties: {
      overall_condition: {
        type: 'string',
        enum: ['sehr gut', 'gut', 'befriedigend', 'mangelhaft', 'unbekannt']
      },
      summary: { type: 'string' },
      total_estimated_repair_cost_eur: { type: ['number', 'null'] },
      duplicate_indices: {
        type: 'array',
        items: { type: 'integer' },
        description:
          'Indizes aus der übergebenen Mängelliste, die denselben Schaden ein zweites Mal ' +
          'beschreiben und entfallen sollen. Leer, wenn es keine Dubletten gibt.'
      },
      verdict: VERDICT
    }
  }
};

/* --------------------------------------------------------------- Prompts */

const LANG_LABEL = { de: 'Deutsch', en: 'English' };

const BASE_RULES = [
  'Harte Regeln:',
  '1. Nur Fakten aus dem Dokument. Nichts hinzuerfinden, nichts aus Fahrzeugmodell/Alter ableiten.',
  '2. Kosten nur übernehmen, wenn sie explizit im Dokument stehen. Sonst null.',
  '3. Jeder Mangel bekommt ein wörtliches Zitat als Beleg ("quote").',
  '4. Doppelte Einträge zusammenfassen (gleicher Schaden auf mehreren Seiten = ein Eintrag).',
  '5. Reine Ausstattungslisten, Werbetexte, AGB und Händlerdaten sind KEINE Mängel.',
  '6. Positive Aussagen ("keine Beanstandung", "i.O.") sind KEINE Mängel.',
  '7. Reifen mit Profiltiefe unter 3 mm als Mangel (severity "mittel"), unter 1,6 mm als "kritisch".',
  '8. Gehe das Dokument vollständig durch, Seite für Seite, auch Anhänge, Tabellen und Fußnoten.',
  '9. Sortiere defects nach Schwere: kritisch, mittel, gering, hinweis.'
];

const VERDICT_RULES = [
  'Kaufempfehlung:',
  '- Beurteile ausschließlich den dokumentierten Zustand und das daraus folgende Risiko.',
  '- Sicherheitsrelevante Mängel (Bremsen, Reifen unter 1,6 mm, Lenkung, Rost an tragenden Teilen,',
  '  Sichtfeldschaden) wiegen schwer und führen mindestens zu "nachverhandeln".',
  '- Unfallschaden, Rost an tragenden Teilen, Motor-/Getriebeschaden oder fehlende Papiere sind',
  '  deal_breakers und führen zu "finger_weg".',
  '- Ohne belastbare Zustandsangaben lautet die Empfehlung "unklar" - nicht raten. Dann score null',
  '  setzen (nicht 0) und in missing_info benennen, welche Angaben für ein Urteil fehlen.',
  '- Steht im Kontext ein Preis, ordne ihn in price_assessment gegen den Zustand ein;',
  '  steht keiner da, setze price_assessment auf null und bewerte nur den Zustand.',
  '- negotiation_points sind konkrete Hebel aus dem Dokument, teuerster zuerst.'
];

export function systemPrompt(lang = 'de', { withVerdict = true } = {}) {
  return [
    'Du bist ein erfahrener Kfz-Sachverständiger und wertest Fahrzeugdokumente aus',
    '(Zustandsberichte, Gutachten, Fahrzeug-Datenblätter, Auktions-Exposés).',
    '',
    'Aufgabe: Extrahiere ALLE dokumentierten Mängel, Schäden und Auffälligkeiten' +
      (withVerdict ? ' und gib anschließend eine Kaufempfehlung.' : '.'),
    '',
    ...BASE_RULES,
    ...(withVerdict ? ['', ...VERDICT_RULES] : []),
    '',
    `Sprache aller Freitexte: ${LANG_LABEL[lang] || 'Deutsch'}.`,
    'Antworte ausschließlich mit dem geforderten JSON.'
  ].join('\n');
}

function contextBlock(pageContext) {
  if (!pageContext || !Object.keys(pageContext).length) return '';
  const lines = Object.entries(pageContext)
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  return lines ? `### Kontext von der Webseite (kann unvollständig sein)\n${lines}\n` : '';
}

export function userPrompt({ pageContext, documents }) {
  const parts = [contextBlock(pageContext)];
  documents.forEach((doc, i) => {
    parts.push(`### Dokument ${i + 1}: ${doc.label || doc.name || 'PDF'}`);
    if (doc.pages) parts.push(`(${doc.pages} Seiten, vollständig enthalten)`);
    parts.push('"""');
    parts.push(doc.text);
    parts.push('"""');
    parts.push('');
  });
  parts.push('Extrahiere jetzt die Mängel und gib die Kaufempfehlung als JSON gemäß Schema.');
  return parts.filter(Boolean).join('\n');
}

export function chunkPrompt({ pageContext, label, text, index, total, pageRange }) {
  return [
    contextBlock(pageContext),
    `### ${label} - Teil ${index + 1} von ${total}${pageRange ? ` (Seiten ${pageRange})` : ''}`,
    'Das Dokument ist lang und wird in Teilen ausgewertet. Werte NUR diesen Teil aus,',
    'vollständig und ohne Auslassung. Eine Gesamtbewertung folgt später.',
    '"""',
    text,
    '"""',
    '',
    'Extrahiere die Mängel dieses Teils als JSON gemäß Schema.'
  ]
    .filter(Boolean)
    .join('\n');
}

export function synthesisPrompt({ pageContext, defects, tires, missingInfo, documents }) {
  const list = defects
    .map(
      (d, i) =>
        `${i}. [${d.severity}] ${d.title} - ${d.area || 'ohne Ort'}` +
        `${typeof d.estimated_cost_eur === 'number' ? ` - ${d.estimated_cost_eur} EUR` : ''}` +
        `${d.source_page ? ` (Seite ${d.source_page})` : ''}\n   ${d.description}`
    )
    .join('\n');

  return [
    contextBlock(pageContext),
    `### Ausgewertete Dokumente\n${documents.map((d) => `- ${d.label}: ${d.pages} Seiten, vollständig gelesen`).join('\n')}`,
    '',
    '### Gefundene Mängel (aus allen Teilen zusammengetragen)',
    list || '(keine)',
    tires?.length
      ? `\n### Reifen\n${tires.map((t) => `- ${t.position}: ${t.dimension || '?'}, ${t.tread_mm ?? '?'} mm`).join('\n')}`
      : '',
    missingInfo?.length ? `\n### Fehlende Angaben\n- ${missingInfo.join('\n- ')}` : '',
    '',
    'Aufgabe: Prüfe die Liste auf Dubletten (derselbe Schaden mehrfach beschrieben) und nenne',
    'deren Indizes in duplicate_indices. Bewerte anschließend den Gesamtzustand und gib die',
    'Kaufempfehlung als JSON gemäß Schema. Erfinde keine neuen Mängel.'
  ]
    .filter(Boolean)
    .join('\n');
}

export function visionUserPrompt(pageContext, { partial = false, pages = [] } = {}) {
  return [
    partial
      ? `Aus dem PDF konnten die Seiten ${pages.join(', ')} nicht als Text gelesen werden (Scan/Grafik).`
      : 'Das PDF enthält keinen auslesbaren Text (Scan).',
    partial ? 'Sie liegen zusätzlich zum Text als Bilder bei.' : 'Die Seiten liegen als Bilder bei.',
    'Lies sie sorgfältig (auch Ankreuzfelder, Tabellen und handschriftliche Notizen)',
    'und extrahiere die Mängel als JSON gemäß Schema.',
    '',
    contextBlock(pageContext)
  ]
    .filter(Boolean)
    .join('\n');
}

/* ---------------------------------------------------------------- Chunks */

/**
 * Zerlegt Text an Seitengrenzen in Stücke bis maxChars.
 * Es geht nichts verloren: Seiten, die allein schon zu groß sind, werden an
 * Absatzgrenzen weiter zerlegt.
 */
export function splitIntoChunks(text, maxChars) {
  const clean = String(text || '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  if (clean.length <= maxChars) return [{ text: clean, pages: pageRangeOf(clean) }];

  const pages = clean.split(/(?=--- Seite \d+ ---)/);
  const chunks = [];
  let current = '';

  const push = () => {
    if (current.trim()) chunks.push({ text: current.trim(), pages: pageRangeOf(current) });
    current = '';
  };

  for (const page of pages) {
    if (page.length > maxChars) {
      push();
      for (const piece of splitByParagraph(page, maxChars)) {
        chunks.push({ text: piece.trim(), pages: pageRangeOf(piece) });
      }
      continue;
    }
    if (current.length + page.length > maxChars) push();
    current += page;
  }
  push();
  return chunks;
}

function splitByParagraph(text, maxChars) {
  const blocks = text.split(/\n\s*\n/);
  const out = [];
  let current = '';
  for (const block of blocks) {
    if (block.length > maxChars) {
      if (current) {
        out.push(current);
        current = '';
      }
      for (let i = 0; i < block.length; i += maxChars) out.push(block.slice(i, i + maxChars));
      continue;
    }
    if (current.length + block.length + 2 > maxChars) {
      out.push(current);
      current = '';
    }
    current += (current ? '\n\n' : '') + block;
  }
  if (current) out.push(current);
  return out;
}

function pageRangeOf(text) {
  const nums = [...String(text).matchAll(/--- Seite (\d+) ---/g)].map((m) => Number(m[1]));
  if (!nums.length) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min === max ? String(min) : `${min}-${max}`;
}

/* ----------------------------------------------------------------- Chat */

/** So viele Frage/Antwort-Paare gehen als Verlauf mit. Mehr kostet nur Token. */
export const CHAT_HISTORY_TURNS = 3;

/**
 * Der Chat beantwortet Fragen ausschließlich aus dem gelesenen Dokument.
 * Kein Weltwissen, keine Schätzungen - dieselbe Regel wie bei der Analyse.
 */
export function chatSystemPrompt(lang = 'de') {
  return [
    'Du beantwortest Fragen zu einem Fahrzeugdokument, das dir vollständig vorliegt.',
    '',
    'Harte Regeln:',
    '1. Antworte ausschließlich aus dem Dokumenttext und den Seitenangaben unten.',
    '2. Steht die Antwort nicht im Dokument, sage genau das - klar und in einem Satz.',
    '   Nicht raten, nichts aus Modell, Baujahr oder Erfahrung ableiten.',
    '3. Nenne bei konkreten Angaben die Seite, z.B. "(Seite 4)".',
    '4. Zitiere wörtlich, wenn ein Zitat die Antwort belegt.',
    '5. Fasse dich kurz: zwei bis fünf Sätze, Listen nur wenn sie wirklich helfen.',
    '6. Keine Kaufempfehlung und keine Preisschätzung - dafür gibt es die Tabs im Panel.',
    '',
    `Sprache: ${LANG_LABEL[lang] || 'Deutsch'}.`
  ].join('\n');
}

/** Der Dokumentteil der Chat-Anfrage. Steht einmal ganz oben, nicht je Runde. */
export function chatDocumentPrompt({ pageContext, documents, maxChars }) {
  const ctx = Object.entries(pageContext || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  let budget = maxChars;
  const parts = [];
  for (const doc of documents || []) {
    if (budget <= 0) break;
    const text = String(doc.text || '');
    const slice = text.slice(0, budget);
    budget -= slice.length;
    parts.push(
      `--- Dokument: ${doc.label || 'Unbenannt'} ---\n${slice}` +
        (slice.length < text.length ? '\n[… gekürzt]' : '')
    );
  }

  return [
    ctx ? `Angaben von der Fahrzeugseite:\n${ctx}\n` : '',
    'Dokumenttext:',
    parts.join('\n\n')
  ]
    .filter(Boolean)
    .join('\n');
}

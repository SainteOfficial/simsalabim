#!/usr/bin/env python3
"""Erzeugt die Test-PDFs in test/fixtures/ (ohne externe Abhaengigkeiten).

    python3 test/make-fixtures.py
"""
import os
import random
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fixtures')


def build_pdf(pages, extra_objects=None, page_resources=None):
    """pages: Liste von Content-Streams (bytes). Baut ein minimales PDF."""
    objs = []
    n_pages = len(pages)
    # 1 Catalog, 2 Pages, dann je Seite ein Page- und ein Content-Objekt
    kids = ' '.join(f'{3 + i * 2} 0 R' for i in range(n_pages))
    objs.append(b'<< /Type /Catalog /Pages 2 0 R >>')
    objs.append(f'<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>'.encode())

    font_obj = 3 + n_pages * 2
    for i, content in enumerate(pages):
        res = (page_resources or {}).get(i, f'<< /Font << /F1 {font_obj} 0 R >> >>')
        objs.append(
            f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources {res} '
            f'/Contents {4 + i * 2} 0 R >>'.encode()
        )
        objs.append(b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream')

    objs.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    for obj in extra_objects or []:
        objs.append(obj)

    out = b'%PDF-1.4\n'
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += str(i).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 ' + str(len(objs) + 1).encode() + b'\n0000000000 65535 f \n'
    for off in offsets:
        out += ('%010d 00000 n \n' % off).encode()
    out += (b'trailer\n<< /Size ' + str(len(objs) + 1).encode() + b' /Root 1 0 R >>\nstartxref\n'
            + str(xref).encode() + b'\n%%EOF\n')
    return out


def text_page(rows):
    parts = ['BT']
    for x, y, size, text in rows:
        esc = text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        parts.append(f'/F1 {size} Tf 1 0 0 1 {x} {y} Tm ({esc}) Tj')
    parts.append('ET')
    return '\n'.join(parts).encode('latin-1')


def image_object(width, height, seed=7):
    random.seed(seed)
    rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            v = 245 if (y // 18) % 2 == 0 or (x // 40) % 3 else 90
            row += bytes((v, v, v))
        rows.append(bytes(row))
    data = zlib.compress(b''.join(rows), 6)
    return (f'<< /Type /XObject /Subtype /Image /Width {width} /Height {height} '
            f'/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode '
            f'/Length {len(data)} >>\nstream\n').encode() + data + b'\nendstream'


def write(name, data):
    path = os.path.join(OUT, name)
    with open(path, 'wb') as fh:
        fh.write(data)
    print(f'{name}: {len(data)} Bytes')


os.makedirs(OUT, exist_ok=True)

# 1) Klassischer Zustandsbericht mit Tabelle
report = text_page([
    (60, 780, 14, 'Zustandsbericht Fahrzeug'),
    (60, 755, 10, 'Fahrgestellnummer: WVGZZZ1T4PW004548'),
    (60, 740, 10, 'Erstzulassung: 16/11/2022    Laufleistung: 207121 km'),
    (60, 700, 12, 'Schaeden und Maengel'),
    (60, 680, 10, 'Position'), (220, 680, 10, 'Beschreibung'), (430, 680, 10, 'Kosten'),
    (60, 662, 10, 'Stossfaenger vorne'), (220, 662, 10, 'Kratzer 20 cm, Lackschaden'), (430, 662, 10, '350,00 EUR'),
    (60, 646, 10, 'Tuer hinten links'), (220, 646, 10, 'Delle handtellergross'), (430, 646, 10, '480,00 EUR'),
    (60, 630, 10, 'Windschutzscheibe'), (220, 630, 10, 'Steinschlag im Sichtfeld'), (430, 630, 10, '690,00 EUR'),
    (60, 614, 10, 'Bremsen hinten'), (220, 614, 10, 'Belaege verschlissen, HU-relevant'), (430, 614, 10, '310,00 EUR'),
    (60, 598, 10, 'Innenraum'), (220, 598, 10, 'Sitzbezug Fahrer eingerissen'), (430, 598, 10, '-'),
    (60, 570, 12, 'Reifen'),
    (60, 552, 10, 'VL 205/55 R16  Profil 5,5 mm'),
    (60, 538, 10, 'VR 205/55 R16  Profil 5,0 mm'),
    (60, 524, 10, 'HL 205/55 R16  Profil 2,5 mm'),
    (60, 510, 10, 'HR 205/55 R16  Profil 1,4 mm'),
    (60, 470, 10, 'Motor und Getriebe: keine Beanstandung'),
    (60, 456, 10, 'Gesamtkosten Instandsetzung: 1830,00 EUR'),
])
write('zustandsbericht.pdf', build_pdf([report]))
write('newsletter.pdf', build_pdf([text_page([(60, 780, 12, 'Newsletter Ausgabe 4')])]))

# 2) Reiner Scan: nur ein Bild, keine Textebene
img = image_object(300, 420)
scan_content = b'q 595 0 0 842 0 0 cm /Im0 Do Q'
write('scan.pdf', build_pdf([scan_content],
                            extra_objects=[img],
                            page_resources={0: '<< /XObject << /Im0 5 0 R >> >>'}))

# 3) Langer Bericht: 30 Seiten, jede mit eigenem Marker -> testet Chunking
long_pages = []
for i in range(1, 31):
    rows = [(60, 800, 12, f'Pruefbericht Seite {i} von 30'),
            (60, 780, 10, f'MARKER-SEITE-{i:02d}')]
    y = 755
    for j in range(28):
        rows.append((60, y, 9, f'Baugruppe {i}.{j} geprueft, Zustand dokumentiert, Position {i * 100 + j}.'))
        y -= 16
    if i == 17:
        rows.append((60, 300, 10, 'Bremsscheiben stark eingelaufen, HU-relevant, 540,00 EUR'))
    if i == 29:
        rows.append((60, 300, 10, 'Rost am Laengstraeger hinten links, tragendes Teil'))
    long_pages.append(text_page(rows))
write('long-report.pdf', build_pdf(long_pages))

# 4) Hybrid: 3 Textseiten + 1 reine Bildseite (z. B. Schadensskizze)
hybrid_text = []
for i in range(1, 4):
    rows = [(60, 800, 12, f'Zustandsbericht Teil {i}'),
            (60, 770, 10, 'Fahrgestellnummer: WBA8E51050K123456')]
    y = 740
    for j in range(20):
        rows.append((60, y, 9, f'Position {i}.{j}: geprueft und dokumentiert.'))
        y -= 16
    hybrid_text.append(text_page(rows))
n_hybrid = len(hybrid_text) + 1
font_obj = 3 + n_hybrid * 2
write('hybrid.pdf', build_pdf(
    hybrid_text + [scan_content],
    extra_objects=[image_object(300, 420, seed=11)],
    page_resources={3: f'<< /XObject << /Im0 {font_obj + 1} 0 R >> >>'}
))

#!/usr/bin/env python3
"""Add a few background images to the existing library; run manually, never during builds.

python3 apps/web/scripts/add-backgrounds.py additions.json

additions.json is a list of rows:
  {"id": "AP-study_room-10", "image": "https://…png", "page": "https://…/", "license": "https://…",
   "source": "AIPICT", "group": "居家", "scene": "书房", "style": "古典书房", "set": "AP-study_room",
   "period": "夜间", "lighting": "开灯", "indoor": true}
period is 日间 / 黄昏 / 夜间 / 室内通用. A family is "set/scene/style"; rows join an existing family when
those match. Ids already in the catalogue are skipped. Images are encoded like import-backgrounds.py
(WebP q82, long side at most 1600px) with Pillow, and the originals' SHA-256 is recorded in sources.json.
"""
import datetime
import hashlib
import io
import json
from pathlib import Path
import sys
import urllib.request

from PIL import Image

WEB = Path(__file__).resolve().parents[1]
DEST = WEB / 'src/assets/backgrounds'
SHARED = WEB.parents[1] / 'packages/shared/src'
PERIOD = {'日间': 'day', '黄昏': 'dusk', '夜间': 'night', '室内通用': 'indoor'}

rows = json.loads(Path(sys.argv[1]).read_text())
catalog = json.loads((DEST / 'catalog.json').read_text())
sources = json.loads((DEST / 'sources.json').read_text())
families = json.loads((SHARED / 'background-families.json').read_text())
known = {a['id'] for a in catalog}
today = datetime.date.today().isoformat()

added = []
for row in rows:
    if row['id'] in known:
        print(f"skip {row['id']} (already in catalogue)")
        continue
    request = urllib.request.Request(row['image'], headers={'User-Agent': 'background-import'})
    with urllib.request.urlopen(request, timeout=120) as response:
        original = response.read()
    image = Image.open(io.BytesIO(original))
    image.load()
    image = image.convert('RGB')
    scale = min(1, 1600 / max(image.size))
    if scale < 1:
        image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    target = DEST / 'images' / f"{row['id']}.webp"
    image.save(target, 'WEBP', quality=82, method=5)
    asset = {
        'id': row['id'], 'group': row['group'], 'scene': row['scene'], 'style': row['style'],
        'family': f"{row['set']}/{row['scene']}/{row['style']}", 'set': row['set'],
        'period': PERIOD[row['period']], 'lighting': row.get('lighting', ''), 'indoor': row.get('indoor', True),
        'width': image.width, 'height': image.height, 'bytes': target.stat().st_size,
    }
    # 同一系列的图排在一起：接在这个系列最后一张后面，新系列放到末尾
    last = max((i for i, a in enumerate(catalog) if a['family'] == asset['family']), default=len(catalog) - 1)
    catalog.insert(last + 1, asset)
    sources.append({
        'id': row['id'], 'source': row['source'], 'page': row['page'], 'image': row['image'],
        'license': row['license'], 'original': row['image'].rsplit('/', 1)[1],
        'originalSha256': hashlib.sha256(original).hexdigest(), 'generated': None,
        'creationMethod': row.get('creationMethod', '来源未披露制作方式'), 'downloaded': today,
    })
    family = next((f for f in families if f['id'] == asset['family']), None)
    if not family:
        family = {'id': asset['family'], 'set': asset['set'], 'scene': asset['scene'],
                  'style': asset['style'], 'indoor': asset['indoor'], 'periods': []}
        families.append(family)
    if asset['period'] not in family['periods']:
        family['periods'].append(asset['period'])
    known.add(row['id'])
    added.append(asset)
    print(f"added {row['id']} {asset['family']} {asset['period']} {asset['lighting']} {asset['width']}x{asset['height']} {asset['bytes']} B")

(DEST / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')) + '\n')
(SHARED / 'background-families.json').write_text(json.dumps(families, ensure_ascii=False, indent=2) + '\n')
(DEST / 'sources.json').write_text(json.dumps(sources, ensure_ascii=False, indent=2) + '\n')
print(f"Added {len(added)} images; library now {len(catalog)} images / {len(families)} families / "
      f"{sum(a['bytes'] for a in catalog) / 1e6:.1f} MB")

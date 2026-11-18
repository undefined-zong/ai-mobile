#!/usr/bin/env python3
"""Import the BG catalogue and encode its images; run manually, never during builds.

python3 apps/web/scripts/import-backgrounds.py /path/to/BG
Requires cwebp. Source files are left untouched.
"""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import sys

SOURCE = Path(sys.argv[1]).expanduser().resolve()
WEB = Path(__file__).resolve().parents[1]
DEST = WEB / 'src/assets/backgrounds'
SHARED = WEB.parents[1] / 'packages/shared/src'
DEST.mkdir(parents=True, exist_ok=True)
(DEST / 'images').mkdir(exist_ok=True)
rows = json.loads((SOURCE / '素材清单.json').read_text())
PERIOD = {'日间': 'day', '黄昏': 'dusk', '夜间': 'night', '室内通用': 'indoor'}
OUTDOORS = {'住宅外观', '庭院', '阳台', '操场', '神社', '公交站', '码头', '铁路沿线', '铁路道口', '乡间道路', '公园', '山景', '山间步道', '河岸', '河岸步道', '海边', '露营地', '住宅街', '商业街', '城市街道', '动物园', '庙会', '游乐园', '警察局', '游泳池'}
OUTDOOR_STYLES = {'校园庭院', '体育馆后方', '大学校园', '室外楼梯', '校园长椅', '春日校门', '教学楼天台', '医院外观', '航站楼外观', '机场跑道', '游轮外观', '游轮甲板', '游轮泳池', '停机坪', '空中飞行', '繁华站前', '乡间站前', '铁路站台', '商店外观', '酒店入口', '现代楼宇1', '现代楼宇2', '旅馆温泉'}


def encode(row):
    target = DEST / 'images' / f"{row['id']}.webp"
    width, height = row['width'], row['height']
    scale = min(1, 1600 / max(width, height))
    width, height = round(width * scale), round(height * scale)
    subprocess.run(['cwebp', '-quiet', '-q', '82', '-m', '5', '-resize', str(width), str(height),
                    '-metadata', 'none', str(SOURCE / row['relative_path']), '-o', str(target)], check=True)
    return {
        'id': row['id'], 'group': row['group'].split('_', 1)[1],
        'scene': row['scene'], 'style': row['style'],
        'family': f"{row['set_id']}/{row['scene']}/{row['style']}",
        'set': row['set_id'], 'period': PERIOD[row['period']], 'lighting': row['lighting'],
        'indoor': row['scene'] not in OUTDOORS and row['style'] not in OUTDOOR_STYLES,
        'width': width, 'height': height, 'bytes': target.stat().st_size,
    }


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    assets = []
    for asset in pool.map(encode, rows):
        assets.append(asset)
        if len(assets) % 100 == 0:
            print(f'Encoded {len(assets)}/{len(rows)}', flush=True)

families = {}
for asset in assets:
    family = families.setdefault(asset['family'], {
        'id': asset['family'], 'set': asset['set'], 'scene': asset['scene'],
        'style': asset['style'], 'indoor': asset['indoor'], 'periods': [],
    })
    if asset['period'] not in family['periods']:
        family['periods'].append(asset['period'])

(DEST / 'catalog.json').write_text(json.dumps(assets, ensure_ascii=False, separators=(',', ':')) + '\n')
(SHARED / 'background-families.json').write_text(json.dumps(list(families.values()), ensure_ascii=False, indent=2) + '\n')
credits = [{
    'id': row['id'], 'source': row['source_name'], 'page': row['source_page'],
    'image': row['image_url'], 'license': row['license_url'],
    'original': row['relative_path'], 'originalSha256': row['sha256'],
    'generated': row['generated'], 'creationMethod': row['creation_method'],
    'downloaded': row['download_date'],
} for row in rows]
(DEST / 'sources.json').write_text(json.dumps(credits, ensure_ascii=False, indent=2) + '\n')
print(f"Imported {len(assets)} images / {len(families)} families / {sum(a['bytes'] for a in assets) / 1e6:.1f} MB")

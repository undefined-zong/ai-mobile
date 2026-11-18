export interface ModelManifest {
  Version: number;
  FileReferences: {
    Moc: string;
    Textures: string[];
    Physics?: string;
    Pose?: string;
    DisplayInfo?: string;
    Expressions?: { Name: string; File: string }[];
    Motions?: Record<string, { File: string; FadeInTime?: number; FadeOutTime?: number }[]>;
  };
  Groups?: { Name: string; Target: string; Ids: string[] }[];
  Layout?: Record<string, number>;
}

export interface ModelPackage {
  manifest: ModelManifest;
  /** Paths are resolved relative to the manifest at import time. */
  files: Record<string, Blob>;
}

export function parseManifest(text: string): ModelManifest {
  const m = JSON.parse(text) as ModelManifest;
  const r = m?.FileReferences;
  if (m?.Version !== 3 || !r || typeof r.Moc !== 'string' || !/\.moc3$/i.test(r.Moc) || !Array.isArray(r.Textures) || !r.Textures.length || r.Textures.some(p => typeof p !== 'string' || !/\.(png|jpe?g|webp)$/i.test(p))) {
    throw new Error('需要 Cubism 3/4/5 的 model3.json、MOC3 和纹理文件');
  }
  if (r.Expressions && (!Array.isArray(r.Expressions) || r.Expressions.some(e => !e || typeof e.Name !== 'string' || typeof e.File !== 'string'))) throw new Error('表情清单格式不正确');
  if (r.Motions && (typeof r.Motions !== 'object' || Object.values(r.Motions).some(group => !Array.isArray(group) || group.some(m => !m || typeof m.File !== 'string')))) throw new Error('动作清单格式不正确');
  if (m.Groups && (!Array.isArray(m.Groups) || m.Groups.some(g => !g || !Array.isArray(g.Ids) || g.Ids.some(id => typeof id !== 'string')))) throw new Error('参数分组格式不正确');
  return m;
}

export function referencedFiles(m: ModelManifest): string[] {
  const r = m.FileReferences;
  return [...new Set([r.Moc, ...r.Textures, r.Physics, r.Pose, r.DisplayInfo,
    ...(r.Expressions ?? []).map(e => e.File),
    ...Object.values(r.Motions ?? {}).flat().map(m => m.File),
  ].filter((p): p is string => !!p))];
}

/** Resolve within the archive, never as a network URL or executable resource. */
export function resolvePath(manifestPath: string, reference: string): string {
  const path = reference.replaceAll('\\', '/');
  if (!path || /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(path) || /[?#\0]/.test(path)) throw new Error(`资源路径无效：${reference}`);
  const parts = manifestPath.replaceAll('\\', '/').split('/').slice(0, -1);
  for (const p of path.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') { if (!parts.length) throw new Error(`资源路径越界：${reference}`); parts.pop(); }
    else parts.push(p);
  }
  return parts.join('/');
}

const basename = (path: string) => path.replaceAll('\\', '/').split('/').pop()!;

/** The part of a motion file name that says what it is: "Madara.idle.motion3.json" → "idle". */
export function motionStem(file: string, moc = ''): string {
  const stem = basename(file).replace(/\.motion3\.json$/i, '').replace(/\.json$/i, '');
  const model = basename(moc).replace(/\.moc3$/i, '');
  if (model && stem.length > model.length && stem.toLowerCase().startsWith(model.toLowerCase())) {
    const rest = stem.slice(model.length).replace(/^[._\-\s]+/, '');
    if (rest) return rest;
  }
  return stem;
}

export interface MotionEntry {
  /** group:index, the key stored in CharacterLive2D.motionMap. */
  key: string;
  group: string;
  stem: string;
  /** Shown to the user instead of the bare key. */
  label: string;
}

const GENERIC_GROUP = /^(|motions?|animations?|anims?|mtn|default|all)$/i;

/** Every motion of the model with a readable name; groups alone ("Gesture:3") say nothing about what a clip does. */
export function motionEntries(m: ModelManifest): MotionEntry[] {
  const seen = new Map<string, number>();
  return Object.entries(m.FileReferences.Motions ?? {}).flatMap(([group, items]) => items.map((item, index) => {
    const stem = motionStem(item.File, m.FileReferences.Moc);
    let label = GENERIC_GROUP.test(group) || stem.toLowerCase().includes(group.toLowerCase()) ? stem : `${group} · ${stem}`;
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    if (count > 1) label = `${label} #${count}`;
    return { key: `${group}:${index}`, group, stem, label };
  }));
}

/**
 * Many exported models ship motion / expression files next to the model without listing them in model3.json.
 * Adopt the ones below the manifest's folder so they can be previewed and mapped like the listed ones.
 */
export function adoptUnreferenced(m: ModelManifest, manifestPath: string, paths: Iterable<string>, limit = 200): string[] {
  const dir = manifestPath.replaceAll('\\', '/').split('/').slice(0, -1).join('/');
  const prefix = dir ? `${dir}/` : '';
  const known = new Set(referencedFiles(m).map(ref => { try { return resolvePath(manifestPath, ref).toLowerCase(); } catch { return ''; } }));
  const adopted: string[] = [];
  const names = new Set((m.FileReferences.Expressions ?? []).map(e => e.Name.toLowerCase()));
  for (const path of [...paths].sort()) {
    if (adopted.length >= limit) break;
    if (!path.startsWith(prefix) || path.startsWith('__MACOSX/') || path.includes('/__MACOSX/') || known.has(path.toLowerCase())) continue;
    const relative = path.slice(prefix.length);
    if (/\.motion3\.json$/i.test(relative)) {
      const folder = relative.split('/').slice(0, -1).pop() ?? '';
      const group = /idle|待机|待機|standby/i.test(`${folder} ${basename(relative)}`) ? 'Idle' : folder && !GENERIC_GROUP.test(folder) ? folder : 'Motion';
      ((m.FileReferences.Motions ??= {})[group] ??= []).push({ File: relative });
      adopted.push(relative);
    } else if (/\.exp3\.json$/i.test(relative)) {
      let name = basename(relative).replace(/\.exp3\.json$/i, '');
      for (let i = 2; names.has(name.toLowerCase()); i++) name = `${basename(relative).replace(/\.exp3\.json$/i, '')} ${i}`;
      names.add(name.toLowerCase());
      (m.FileReferences.Expressions ??= []).push({ Name: name, File: relative });
      adopted.push(relative);
    }
  }
  return adopted;
}

/** Remove one motion / expression file from the manifest (an adopted file that turned out unreadable). */
export function dropReference(m: ModelManifest, file: string) {
  const r = m.FileReferences;
  if (r.Expressions) r.Expressions = r.Expressions.filter(e => e.File !== file);
  for (const [group, items] of Object.entries(r.Motions ?? {})) {
    const kept = items.filter(item => item.File !== file);
    if (kept.length) r.Motions![group] = kept;
    else delete r.Motions![group];
  }
}

/**
 * 程序文字：程序拼进程序块的说明文字（场景规则、当前环境、场景任务、各个任务的输入……）都写在预设文件的 texts 里
 * （键 → 模板），代码里只有键和数据，不写说明文字。预设编辑页"程序文字"里能看能改。
 *
 * 模板写法：
 * - {{名字}}：换成数据；数据为空（没有、空字符串、false、空列表）时整行不要；
 * - [[……]]：可有可无的一段，里面的数据为空时只去掉这一段（例如 `{{name}}[[（{{status}}）]]`），可以套；
 * - {{?名字}}：条件，数据为空时整行（或所在的 [[ ]]）不要，本身不显示；{{!名字}}：反过来，数据不为空时不要；
 * - {{名字|分隔}}：列表用分隔连起来（\n 是换行），不写分隔时用"、"。
 * 0 不算空。程序没给的名字原样保留（例如 {{user}}，留给后面的宏替换）。
 */
export type TextValue = string | number | boolean | null | undefined | readonly string[];
export type TextVars = Record<string, TextValue>;
export type Texts = Record<string, string>;

const TOKEN = /\{\{([?!]?)([\w.-]+)(?:\|((?:[^}]|\}(?!\}))*))?\}\}/g;
/** 最里层的 [[ ]]（里面不再有 [[ 或 ]]）：从里往外一层层处理，可以套 */
const GROUP = /\[\[((?:(?!\[\[|\]\])[\s\S])*)\]\]/g;

function isEmpty(v: TextValue): boolean {
  return v === undefined || v === null || v === false || v === '' || (Array.isArray(v) && !v.length);
}

/** 一段文字换数据；drop = 这一段里有为空的数据 */
function fill(text: string, vars: TextVars): { text: string; drop: boolean } {
  let drop = false;
  const out = text.replace(TOKEN, (m, flag: string, name: string, sep: string | undefined) => {
    // 没给的名字原样留着（{{user}} {{char}} 这些 SillyTavern 宏交给后面替换）
    if (!(name in vars)) return m;
    const v = vars[name];
    const empty = isEmpty(v);
    if (flag === '!') {
      if (!empty) drop = true;
      return '';
    }
    if (empty) {
      drop = true;
      return '';
    }
    if (flag === '?' || v === true) return '';
    if (Array.isArray(v)) return v.join(sep === undefined ? '、' : sep.replace(/\\n/g, '\n'));
    return String(v);
  });
  return { text: out, drop };
}

export function renderText(template: string, vars: TextVars = {}): string {
  const lines: string[] = [];
  for (const line of template.replace(/\r\n?/g, '\n').split('\n')) {
    let withGroups = line;
    for (let prev = ''; prev !== withGroups; ) {
      prev = withGroups;
      withGroups = withGroups.replace(GROUP, (_m, inner: string) => {
        const r = fill(inner, vars);
        // 换好的文字里可能有 {{ }}（数据里带的），先藏起来免得外层再换一次
        return r.drop ? '' : protect(r.text);
      });
    }
    const r = fill(withGroups, vars);
    if (!r.drop) lines.push(unprotect(r.text));
  }
  return lines.join('\n');
}

// 内层换好的一段：把 {{ }} [[ ]] 换成私用区字符，外层就不会再当成写法处理；最后换回来
const PROTECT: [string, string][] = [['{{', '\uE000'], ['}}', '\uE001'], ['[[', '\uE002'], [']]', '\uE003']];
function protect(s: string): string {
  return PROTECT.reduce((x, [a, b]) => x.split(a).join(b), s);
}
function unprotect(s: string): string {
  return PROTECT.reduce((x, [a, b]) => x.split(b).join(a), s);
}

/** 模板里用到的数据名（编辑页列出来） */
export function textVarNames(template: string): string[] {
  return [...new Set([...template.matchAll(TOKEN)].map((m) => m[2]!))];
}

/**
 * 按键取一段程序文字并换上数据。texts 是这一次预设的程序文字（已经合上自带预设文件里的，见 web 的 library.textsFor）。
 * 键找不到时返回空并在控制台报错（说明预设文件里少了这一段）。
 */
export function programText(texts: Texts | undefined, key: string, vars: TextVars = {}): string {
  const t = texts?.[key];
  if (t === undefined) {
    (globalThis as { console?: { error(...a: unknown[]): void } }).console?.error(`程序文字"${key}"在预设里找不到`);
    return '';
  }
  return renderText(t, vars);
}

/** 绑定一份程序文字：t('键', 数据) */
export type TextFn = (key: string, vars?: TextVars) => string;
export function textFn(texts: Texts | undefined): TextFn {
  return (key, vars) => programText(texts, key, vars);
}

<script setup lang="ts">
import { errorText } from '@app/ai';
import type { WereadShelfBook } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import SceneShell from '@/components/scene/SceneShell.vue';
import { chaptersFromText, closePdf, imageFileData, parseEpub, parsePdf, parseTxt, readPageText, rememberPdfPassword, type BookChapter, type BookFormat, type BookMeta } from '@/services/books';
import { cachedWereadShelf, importWereadBook, refreshWereadBook, wereadConnection, wereadShelf } from '@/services/weread';
import { useAppStore } from '@/stores/app';
import { useBookStore } from '@/stores/books';
import { useCharacterStore } from '@/stores/characters';
import { useLibraryStore } from '@/stores/library';
import { uid } from '@/utils/id';
import BookCover from './BookCover.vue';

/**
 * 一起看书的书架页（点进一本书去阅读页）：
 * - "我们的书架"：本机的书（导入的 EPUB / TXT / PDF、粘贴的文章、拍的书页、从微信读书取来的正文和笔记）。
 *   书多了也好找：搜书名和作者，按最近读 / 最近加入 / 书名 / 读到多少排，按在读 / 没开始 / 读完筛；
 *   最上面是上次读的那本，书目一次只画一屏，往下滑再接着画；
 * - "微信读书"：那边书架上的书（微信读书 MCP），点一本按目录取完整正文和笔记放上我们的书架。
 * 书架页只读书目（很小），正文翻开时才读（stores/books.ts）。
 */
const emit = defineEmits<{ (e: 'open', id: string): void }>();

const app = useAppStore();
const chars = useCharacterStore();
const shelf = useBookStore();
const lib = useLibraryStore();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const view = shelf.shelfView;
const busy = ref('');

const FORMAT_LABEL: Record<BookFormat, string> = { txt: 'TXT', epub: 'EPUB', pdf: 'PDF', paste: '文章', photo: '拍的书页', weread: '微信读书' };
/** 每个页签能怎么排、怎么筛 */
const SORTS = {
  local: { recent: '最近读', added: '最近加入', title: '书名', progress: '读到多少' },
  weread: { recent: '最近读', title: '书名', progress: '读到多少', notes: '笔记多' },
} as const;
const FILTERS = {
  local: { all: '全部', reading: '在读', unread: '没开始', done: '读完' },
  weread: { all: '全部', noted: '有笔记', reading: '在读', done: '读完' },
} as const;
const sorts = computed<Record<string, string>>(() => SORTS[view.tab]);
const filters = computed<Record<string, string>>(() => FILTERS[view.tab]);
function setTab(tab: 'local' | 'weread') {
  view.tab = tab;
  if (!(view.sort in sorts.value)) view.sort = 'recent';
  if (!(view.filter in filters.value)) view.filter = 'all';
  if (tab === 'weread' && !wr.books && !wr.loading) void loadWeread();
}

const byTitle = (a: string, b: string) => a.localeCompare(b, 'zh-Hans-CN');
const matches = (q: string, ...fields: (string | undefined)[]) => !q || fields.some((f) => f?.toLowerCase().includes(q));

// —— 我们的书架 ——
const status = (b: BookMeta) => ((b.progress ?? 0) >= 100 ? 'done' : (b.progress ?? 0) > 0 || b.pos.chapter > 0 || b.pos.para > 0 ? 'reading' : 'unread');
const localCounts = computed(() => {
  const n: Record<string, number> = { all: shelf.books.length, reading: 0, unread: 0, done: 0 };
  for (const b of shelf.books) n[status(b)]! += 1;
  return n;
});
const localList = computed(() => {
  const q = view.query.trim().toLowerCase();
  const out = shelf.books.filter((b) => (view.filter === 'all' || status(b) === view.filter) && matches(q, b.title, b.author));
  const by: Record<string, (a: BookMeta, b: BookMeta) => number> = {
    recent: (a, b) => b.updatedAt - a.updatedAt,
    added: (a, b) => b.createdAt - a.createdAt,
    title: (a, b) => byTitle(a.title, b.title),
    progress: (a, b) => (b.progress ?? 0) - (a.progress ?? 0),
  };
  return out.sort(by[view.sort] ?? by.recent);
});
/** 上次读到一半的那本：没在搜、没在筛时放最上面 */
const current = computed(() =>
  !view.query.trim() && view.filter === 'all' ? [...shelf.books].sort((a, b) => b.updatedAt - a.updatedAt).find((b) => status(b) === 'reading') : undefined,
);
function sub(b: BookMeta): string {
  const s = status(b);
  const where = s === 'done' ? '读完了' : s === 'unread' ? '还没开始' : `读到 ${b.progress ?? 0}%`;
  return [FORMAT_LABEL[b.format], where].join(' · ');
}

// —— 微信读书 ——
const wr = reactive<{ books: WereadShelfBook[] | null; loading: boolean; error: string }>({ books: cachedWereadShelf(), loading: false, error: '' });
const connection = computed(() => wereadConnection());
async function loadWeread(force = false) {
  if (!connection.value.ok) return;
  wr.loading = true;
  wr.error = '';
  try {
    wr.books = await wereadShelf(force);
  } catch (e) {
    wr.error = errorText(e);
  } finally {
    wr.loading = false;
  }
}
const onShelf = computed(() => new Map(shelf.books.filter((b) => b.weread).map((b) => [b.weread!.bookId, b.id])));
const wStatus = (b: WereadShelfBook) => (b.finishReading || b.progress >= 100 ? 'done' : b.progress > 0 ? 'reading' : 'unread');
const wereadCounts = computed(() => {
  const all = wr.books ?? [];
  return { all: all.length, noted: all.filter((b) => b.noteCount + b.bookmarkCount > 0).length, reading: all.filter((b) => wStatus(b) === 'reading').length, done: all.filter((b) => wStatus(b) === 'done').length } as Record<string, number>;
});
const wereadList = computed(() => {
  const q = view.query.trim().toLowerCase();
  const keep: Record<string, (b: WereadShelfBook) => boolean> = {
    all: () => true,
    noted: (b) => b.noteCount + b.bookmarkCount > 0,
    reading: (b) => wStatus(b) === 'reading',
    done: (b) => wStatus(b) === 'done',
  };
  const by: Record<string, (a: WereadShelfBook, b: WereadShelfBook) => number> = {
    recent: (a, b) => b.readAt - a.readAt,
    title: (a, b) => byTitle(a.title, b.title),
    progress: (a, b) => b.progress - a.progress,
    notes: (a, b) => b.noteCount + b.bookmarkCount - (a.noteCount + a.bookmarkCount),
  };
  return (wr.books ?? []).filter((b) => (keep[view.filter] ?? keep.all!)(b) && matches(q, b.title, b.author, ...b.categories)).sort(by[view.sort] ?? by.recent);
});
async function openWeread(b: WereadShelfBook) {
  busy.value = `正在从微信读书取《${b.title}》的目录…`;
  try {
    emit('open', await importWereadBook(b, importProgress));
  } catch (e) {
    showToast(errorText(e));
  } finally {
    busy.value = '';
  }
}

function importProgress(loaded: number, total: number, title: string) {
  busy.value = loaded < total ? `正在取全书正文 ${loaded}/${total} 章 · ${title}` : `正文 ${total}/${total} 章已取好，正在整理划线和想法…`;
}

const counts = computed(() => (view.tab === 'local' ? localCounts.value : wereadCounts.value));
const list = computed<(BookMeta | WereadShelfBook)[]>(() => (view.tab === 'local' ? localList.value : wereadList.value));

// —— 一次只画一屏，滑到底再接着画 ——
const PAGE = 36;
const limit = ref(PAGE);
const scroller = ref<HTMLElement | null>(null);
const sentinel = ref<HTMLElement | null>(null);
let io: IntersectionObserver | null = null;
watch(
  () => [view.tab, view.query, view.sort, view.filter],
  () => {
    limit.value = PAGE;
    scroller.value?.scrollTo({ top: 0 });
  },
);
watch(sentinel, (el) => {
  io?.disconnect();
  if (!el || typeof IntersectionObserver === 'undefined') return;
  io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (limit.value += PAGE), { root: scroller.value, rootMargin: '400px 0px' });
  io.observe(el);
});
onBeforeUnmount(() => io?.disconnect());
const shown = computed(() => list.value.slice(0, limit.value));

// —— 一本书的操作：改名、从微信读书更新、拿走 ——
const menuFor = ref<BookMeta | null>(null);
const menuActions = computed(() => {
  const b = menuFor.value;
  if (!b) return [];
  return [{ name: '改书名', key: 'rename' }, ...(b.weread ? [{ name: b.weread.content === 'full' ? '从微信读书更新正文和笔记' : '从微信读书获取全书正文', key: 'refresh' }] : []), { name: '从书架上拿走', key: 'remove', color: 'var(--warn)' }];
});
const renameOpen = ref(false);
const renameText = ref('');
let renaming: BookMeta | null = null;
async function onMenu(a: { key: string }) {
  const b = menuFor.value;
  menuFor.value = null;
  if (!b) return;
  if (a.key === 'rename') {
    renaming = b;
    renameText.value = b.title;
    renameOpen.value = true;
  } else if (a.key === 'refresh') {
    busy.value = `正在从微信读书更新《${b.title}》…`;
    try {
      await refreshWereadBook(b.id, importProgress);
      showToast('更新好了');
    } catch (e) {
      showToast(errorText(e));
    } finally {
      busy.value = '';
    }
  } else if (a.key === 'remove') {
    const ok = await showConfirmDialog({ title: '从书架上拿走', message: `《${b.title}》和里面的批注都会删掉`, confirmButtonText: '拿走' }).then(() => true, () => false);
    if (!ok) return;
    closePdf(b.id);
    shelf.remove(b.id);
  }
}
function saveRename() {
  const t = renameText.value.trim();
  if (renaming && t) shelf.patch(renaming.id, { title: t });
  renameOpen.value = false;
  renaming = null;
}

// —— 放书上架 ——
const addOpen = ref(false);
const stem = (n: string) => n.replace(/\.[^.]+$/, '');
function newBook(title: string, format: BookFormat, chapters: BookChapter[], extra: Partial<BookMeta> = {}) {
  const now = Date.now();
  return { id: uid('book'), title: title || '没有书名', format, chapters, notes: [], createdAt: now, updatedAt: now, pos: { chapter: 0, para: 0 }, chapterCount: chapters.length, ...extra };
}
async function shelve(run: () => Promise<void>, label: string) {
  addOpen.value = false;
  busy.value = label;
  try {
    await run();
    view.tab = 'local';
    showToast('放上书架了');
  } catch (err) {
    showToast(`读不出来：${errorText(err)}`);
  } finally {
    busy.value = '';
  }
}
function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!file) return;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext !== 'pdf' && ext !== 'epub' && ext !== 'txt') return showToast('只认 EPUB、TXT、PDF');
  void shelve(async () => {
    if (ext === 'pdf') {
      const r = await parsePdf(file, async () => window.prompt('这个 PDF 有密码，请输入：'));
      const b = newBook(r.title || stem(file.name), 'pdf', r.chapters, { pageCount: r.pageCount, technical: r.technical });
      rememberPdfPassword(b.id, r.password);
      await shelf.add(b, file);
    } else if (ext === 'epub') {
      const r = await parseEpub(file);
      await shelf.add(newBook(r.title || stem(file.name), 'epub', r.chapters));
    } else await shelf.add(newBook(stem(file.name), 'txt', await parseTxt(file)));
  }, `正在读《${stem(file.name)}》…`);
}
const pasteOpen = ref(false);
const pasteTitle = ref('');
const pasteText = ref('');
async function addPasted() {
  const chapters = chaptersFromText(pasteText.value);
  if (!chapters.length) return showToast('先粘贴正文');
  await shelf.add(newBook(pasteTitle.value.trim() || '粘贴的文章', 'paste', chapters));
  pasteOpen.value = false;
  pasteText.value = '';
  pasteTitle.value = '';
  view.tab = 'local';
}
/** 识图读书页的说明在"一起看书"功能预设里 */
function ocrInstruction(): string {
  const text = lib.presetForUse('scene:read', her.value)?.blocks.find((b) => b.identifier === 'readOcr')?.content.trim() ?? '';
  if (!text) throw new Error('"一起看书"预设里没有"识图读书页"这一块');
  return text;
}
function onPhotos(e: Event) {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  (e.target as HTMLInputElement).value = '';
  if (!files.length) return;
  void shelve(async () => {
    const instruction = ocrInstruction();
    const chapters: BookChapter[] = [];
    for (const [i, f] of files.entries()) chapters.push({ title: `第 ${i + 1} 页`, paras: await readPageText(await imageFileData(f), instruction) });
    await shelf.add(newBook(`拍的书页 ${new Date().toLocaleDateString()}`, 'photo', chapters));
  }, `识图正在读 ${files.length} 页…`);
}

if (view.tab === 'weread' && !wr.books) void nextTick(() => loadWeread());
</script>

<template>
  <SceneShell scene-id="read" hide-figure fill pose="sit" title="我们的书架" :layout="{ left: 78, bottom: 56, height: 30 }">
    <template #actions>
      <button type="button" class="add-pill" aria-label="放书上架" @click="addOpen = true"><span class="i-lucide-plus text-[18px]" /></button>
    </template>

    <div v-if="busy" class="notice" role="status" aria-live="polite"><van-loading size="14px" />{{ busy }}</div>

    <div class="tabs" role="tablist" aria-label="书架">
      <button type="button" role="tab" :aria-selected="view.tab === 'local'" :class="{ on: view.tab === 'local' }" @click="setTab('local')">
        我们的书架<span class="num">{{ shelf.books.length }}</span>
      </button>
      <button type="button" role="tab" :aria-selected="view.tab === 'weread'" :class="{ on: view.tab === 'weread' }" @click="setTab('weread')">
        微信读书<span v-if="wr.books" class="num">{{ wr.books.length }}</span>
      </button>
    </div>

    <div class="tools">
      <label class="search">
        <span class="i-lucide-search shrink-0 text-ink-3" />
        <input v-model="view.query" type="search" placeholder="搜书名、作者" aria-label="搜书" />
      </label>
      <select v-model="view.sort" class="sort" aria-label="怎么排">
        <option v-for="(label, k) in sorts" :key="k" :value="k">{{ label }}</option>
      </select>
      <button v-if="view.tab === 'weread' && connection.ok" type="button" class="icon-btn" aria-label="重新取微信读书书架" :disabled="wr.loading" @click="loadWeread(true)">
        <span class="i-lucide-refresh-cw" :class="{ spin: wr.loading }" />
      </button>
    </div>
    <div class="chips">
      <button v-for="(label, k) in filters" :key="k" type="button" class="chip" :class="{ on: view.filter === k }" @click="view.filter = k">
        {{ label }}<span class="num">{{ counts[k] ?? 0 }}</span>
      </button>
    </div>

    <div ref="scroller" class="scroll">
      <!-- 我们的书架 -->
      <template v-if="view.tab === 'local'">
        <button v-if="current" type="button" class="hero press" @click="emit('open', current.id)">
          <BookCover class="hero-cover" :title="current.title" :cover="current.cover" />
          <span class="flex-1 min-w-0 text-left">
            <span class="block text-[12px] text-ink-3">上次读到</span>
            <span class="block truncate text-[15px] font-600">{{ current.title }}</span>
            <span class="block truncate text-[12.5px] text-ink-2">{{ current.chapterTitle }}</span>
            <span class="bar mt-2"><span :style="{ width: `${current.progress ?? 0}%` }" /></span>
          </span>
          <span class="go">继续读</span>
        </button>

        <div v-if="!shelf.books.length" class="empty">
          <span class="i-lucide-library text-[30px] text-ink-3" />
          <span>书架还是空的。书只存在这台设备上，发给模型的只有当前这几页。</span>
          <van-button size="small" round type="primary" @click="addOpen = true">放一本书上来</van-button>
        </div>
        <div v-else-if="!list.length" class="empty"><span>没有找到这样的书</span></div>
      </template>

      <!-- 微信读书 -->
      <template v-else>
        <div v-if="!connection.ok" class="empty">
          <span class="i-lucide-book-open-text text-[30px] text-ink-3" />
          <span>{{ connection.reason }}</span>
          <van-button size="small" round type="primary" @click="router.push(connection.to)">去设置</van-button>
          <span class="text-[12px] text-ink-3">接上以后，微信读书书架上的书会列在这里；点一本，把全书正文和你的笔记取过来一起看。</span>
        </div>
        <div v-else-if="wr.loading && !wr.books" class="empty"><van-loading size="20px" /><span>正在取微信读书的书架…</span></div>
        <div v-else-if="wr.error" class="empty">
          <span class="err">{{ wr.error }}</span>
          <van-button size="small" round @click="loadWeread(true)">再试一次</van-button>
        </div>
        <div v-else-if="wr.books && !list.length" class="empty"><span>没有找到这样的书</span></div>
      </template>

      <div v-if="shown.length" class="grid">
        <div v-for="b in shown" :key="'id' in b ? b.id : b.bookId" class="card">
          <template v-if="'id' in b">
            <button type="button" class="press block w-full text-left" :aria-label="`翻开《${b.title}》`" @click="emit('open', b.id)">
              <BookCover :title="b.title" :author="b.author" :cover="b.cover" :badge="b.format === 'weread' ? (b.weread?.content === 'full' ? '正文' : '笔记') : undefined" />
              <span class="bar"><span :style="{ width: `${b.progress ?? 0}%` }" /></span>
            </button>
            <div class="info">
              <span class="t">{{ b.title }}</span>
              <button type="button" class="more" :aria-label="`《${b.title}》的更多操作`" @click="menuFor = b"><span class="i-lucide-ellipsis" /></button>
            </div>
            <span class="s">{{ sub(b) }}</span>
          </template>
          <template v-else>
            <button type="button" class="press block w-full text-left" :aria-label="`和${her.name}一起读《${b.title}》`" :disabled="!!busy" @click="openWeread(b)">
              <BookCover :title="b.title" :author="b.author" :cover="b.cover" :badge="onShelf.has(b.bookId) ? '在书架上' : undefined" />
              <span class="bar"><span :style="{ width: `${b.progress}%` }" /></span>
            </button>
            <div class="info"><span class="t">{{ b.title }}</span></div>
            <span class="s">{{ b.author || '佚名' }}<template v-if="b.bookmarkCount || b.noteCount"> · 划线 {{ b.bookmarkCount }} · 想法 {{ b.noteCount }}</template></span>
          </template>
        </div>
      </div>
      <div v-if="shown.length < list.length" ref="sentinel" class="more-row">
        <button type="button" class="text-accent-ink" @click="limit += PAGE">还有 {{ list.length - shown.length }} 本</button>
      </div>
    </div>

    <van-action-sheet :show="!!menuFor" :actions="menuActions" :description="menuFor ? `《${menuFor.title}》` : ''" cancel-text="算了" close-on-click-action @select="onMenu" @cancel="menuFor = null" @click-overlay="menuFor = null" />

    <van-popup v-model:show="addOpen" position="bottom" round>
      <div class="p-4">
        <div class="text-[15px] font-600 mb-3">放书上架</div>
        <div class="grid grid-cols-3 gap-2">
          <label class="add press"><span class="i-lucide-file-up text-[20px]" />EPUB / TXT / PDF<input type="file" class="hidden" accept=".epub,.txt,.pdf" @change="onFile" /></label>
          <button type="button" class="add press" @click="(addOpen = false), (pasteOpen = true)"><span class="i-lucide-clipboard-paste text-[20px]" />粘贴文章</button>
          <label class="add press"><span class="i-lucide-camera text-[20px]" />拍书页<input type="file" class="hidden" accept="image/*" capture="environment" multiple @change="onPhotos" /></label>
        </div>
        <button type="button" class="add press w-full mt-2 !flex-row !justify-center" @click="(addOpen = false), setTab('weread')"><span class="i-lucide-book-open-text text-[18px]" />从微信读书取全书正文</button>
        <div class="text-[12px] text-ink-3 mt-3 leading-relaxed">教材、讲义、论文也能读：扫描页和有公式的页交给"识图"读成文字，公式照书上的样子显示。</div>
      </div>
    </van-popup>
    <van-popup v-model:show="pasteOpen" position="bottom" round :style="{ height: '70%' }">
      <div class="p-4 flex flex-col gap-2 h-full">
        <div class="text-[15px] font-600">粘贴一篇文章</div>
        <input v-model="pasteTitle" class="field !flex-none" placeholder="标题" aria-label="标题" />
        <textarea v-model="pasteText" class="area flex-1" placeholder="把正文粘贴到这里（公式可以用 $…$ 和 $$…$$ 写）" aria-label="正文" />
        <van-button type="primary" round block @click="addPasted">放上书架</van-button>
      </div>
    </van-popup>
    <van-popup v-model:show="renameOpen" position="bottom" round>
      <div class="p-4 flex flex-col gap-2">
        <div class="text-[15px] font-600">改书名</div>
        <input v-model="renameText" class="field" aria-label="书名" @keydown.enter="saveRename" />
        <van-button type="primary" round block @click="saveRename">好了</van-button>
      </div>
    </van-popup>
  </SceneShell>
</template>

<style scoped>
.notice {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.add-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--accent-ink);
}
.tabs {
  display: flex;
  flex: none;
  gap: 18px;
  border-bottom: 1px solid var(--border);
}
.tabs button {
  position: relative;
  padding: 2px 0 8px;
  font-size: 15px;
  color: var(--ink-3);
}
.tabs button.on {
  color: var(--ink);
  font-weight: 600;
}
.tabs button.on::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
}
.num {
  margin-left: 4px;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.tools {
  display: flex;
  flex: none;
  gap: 8px;
  margin-top: 10px;
}
.search {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--panel);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  appearance: none;
  background: none;
  outline: none;
  font-size: 14px;
}
.sort {
  flex: none;
  height: 34px;
  padding: 0 8px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.icon-btn {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 17px;
  background: var(--panel);
  color: var(--ink-2);
}
.chips {
  display: flex;
  flex: none;
  gap: 6px;
  margin-top: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.chip {
  height: 26px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  white-space: nowrap;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.chip.on .num {
  color: inherit;
}
.scroll {
  flex: 1 1 0;
  min-height: 200px;
  overflow-y: auto;
  margin: 10px -4px 0;
  padding: 2px 4px 8px;
}
.hero {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin-bottom: 14px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--panel);
}
.hero-cover {
  width: 52px;
  flex: none;
}
.hero-cover :deep(.t) {
  font-size: 10px;
  -webkit-line-clamp: 3;
}
.go {
  flex: none;
  padding: 6px 12px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
}
.bar {
  display: block;
  height: 3px;
  margin-top: 6px;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;
}
.bar > span {
  display: block;
  height: 100%;
  background: var(--accent);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 16px 12px;
}
.card {
  min-width: 0;
}
.info {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  margin-top: 6px;
}
.info .t {
  flex: 1;
  min-width: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.35;
}
.more {
  flex: none;
  width: 22px;
  height: 18px;
  color: var(--ink-3);
}
.card .s {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 28px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--ink-2);
  line-height: 1.6;
}
.err {
  color: var(--warn);
  word-break: break-all;
}
.more-row {
  padding: 16px 0 4px;
  text-align: center;
  font-size: 13px;
}
.add {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 4px;
  border-radius: 14px;
  background: var(--panel);
  font-size: 12.5px;
  text-align: center;
}
.field {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 14px;
}
.area {
  width: 100%;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 14px;
  resize: none;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

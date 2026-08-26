import { requireLogin, describeError, logout, getProfile } from './api.js';
import {
  scanFiles, availableDifficulties, buildPrefill, submitLevel, probeVideo,
} from './upload.js';
import { DIFF_NAMES, DIFF_COLORS, LOCALE_LABELS } from './songlist.js';
import {
  decodeAudio, sniff, defaultPreviewRange,
} from './media.js';
import { openChartPackage } from './chart-package.js';
import { analyzeSfx } from './aff.js';
import { prepareChartPackage, buildFfmpegCommand } from './replace.js';
import { createPreviewRangeEditor } from './preview-range.js';
import { el, clear, commandBlock } from './ui.js';
import {
  createResourceRow, createFilePicker, formatResourceSize,
  renderChangeSummary, thumbImage,
} from './resource-editor.js';

if (!requireLogin()) throw new Error('redirecting');
document.getElementById('logout').addEventListener('click', logout);

const $ = id => document.getElementById(id);
const dropzone = $('dropzone');
const folderPicker = $('folder-picker');
const filePicker = $('file-picker');
const resourceBox = $('resource-editor');
const importNote = $('import-note');
const form = $('form');
const identityName = getProfile().nickname || '当前身份';
$('current-identity').textContent = identityName;

let scan = scanFiles([]);
let folderName = '';
let difficultyIndex = 0;
let decodedBuffer = null;
let rangeEditor = null;
let audioSequence = 0;
let imported = false;
let packageOthers = [];
let videoProbe = null;
let objectUrls = [];
let sfxAnalysis = null;
let sfxAnalysisSource = null;

const draft = {
  chart: null,
  cover: null,
  music: null,
  background: null,
  effect: null,
  sfx: [],
  video: null,
};

const trackedFields = [
  'levelName', 'composerName', 'charterName', 'artistName', 'displayDifficulty',
  'baseBpm', 'bpm', 'chartConstant',
];

$('charterName').addEventListener('input', paintCharterHint);
for (const id of trackedFields) {
  $(id).addEventListener('input', event => { event.target.dataset.touched = '1'; });
}
$('levelName').addEventListener('input', paintTitleOptions);

$('themeColor').addEventListener('input', () => {
  if (/^#[0-9a-f]{6}$/i.test($('themeColor').value)) $('themeSwatch').value = $('themeColor').value;
});
$('themeSwatch').addEventListener('input', () => { $('themeColor').value = $('themeSwatch').value.toUpperCase(); });

$('choose-folder').addEventListener('click', () => folderPicker.click());
$('choose-files').addEventListener('click', () => filePicker.click());
folderPicker.addEventListener('change', () => importFiles([...folderPicker.files], folderPicker.files[0]?.webkitRelativePath?.split('/')[0] || '', true));
filePicker.addEventListener('change', () => importFiles([...filePicker.files], folderName, !imported));

dropzone.addEventListener('click', () => filePicker.click());
dropzone.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); filePicker.click(); }
});
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('over'));
}
dropzone.addEventListener('drop', async event => {
  event.preventDefault();
  const result = await filesFromDrop(event.dataTransfer);
  await importFiles(result.files, result.name || folderName, !imported);
});

async function filesFromDrop(transfer) {
  const entries = [...transfer.items].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return { files: [...transfer.files], name: '' };

  const files = [];
  const walk = async entry => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      try {
        Object.defineProperty(file, 'webkitRelativePath', {
          value: entry.fullPath.replace(/^\//, ''), configurable: true,
        });
      } catch { /* 退化成按文件名识别 */ }
      files.push(file);
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child);
    }
  };
  for (const entry of entries) await walk(entry);
  const directory = entries.find(entry => entry.isDirectory);
  return { files, name: directory?.name || '' };
}

function blankDraft() {
  draft.chart = draft.cover = draft.music = draft.background = draft.effect = draft.video = null;
  draft.sfx = [];
  packageOthers = [];
  sfxAnalysis = null;
  sfxAnalysisSource = null;
}

function clearTouchedFields() {
  for (const id of trackedFields) delete $(id).dataset.touched;
}

function ref(file) {
  return file ? { file, name: file.name } : null;
}

function mergeIncoming(incoming, reset = false) {
  if (reset) {
    scan = incoming;
    blankDraft();
  } else {
    for (const index of incoming.charts.keys()) {
      for (const file of incoming.chartCandidates[index] || []) {
        if (!scan.chartCandidates[index].some(existing => existing === file)) scan.chartCandidates[index].push(file);
      }
      if (!scan.charts[index]) scan.charts[index] = incoming.charts[index];
    }
    for (const kind of ['music', 'cover', 'songlist', 'effect', 'background', 'video']) {
      for (const file of incoming.candidates[kind] || []) {
        if (!scan.candidates[kind].some(existing => existing === file)) scan.candidates[kind].push(file);
      }
      if (!scan[kind]) scan[kind] = incoming[kind];
    }
    for (const file of incoming.wavs) if (!scan.wavs.some(existing => existing === file)) scan.wavs.push(file);
    scan.leftover.push(...incoming.leftover);
    scan.conflicts.push(...incoming.conflicts);
  }

  if (!draft.chart && scan.charts[difficultyIndex]) draft.chart = ref(scan.charts[difficultyIndex]);
  if (!draft.cover && scan.cover) draft.cover = ref(scan.cover);
  if (!draft.music && scan.music) draft.music = ref(scan.music);
  if (!draft.background && scan.background) draft.background = ref(scan.background);
  if (!draft.effect && scan.effect) draft.effect = ref(scan.effect);
  if (!draft.video && scan.video) draft.video = ref(scan.video);
  if (!draft.sfx.length) draft.sfx = scan.wavs.map(ref);
}

async function importFiles(files, name, reset) {
  if (!files.length) return;
  if (reset && imported && !window.confirm('重新导入会清除当前还未上传的资源选择，继续吗？')) return;

  // 单个 ZIP 直接展开，进入与文件夹完全相同的资源清单。
  let zipBytes = null;
  if (files.length === 1) {
    if (files[0].name.toLowerCase().endsWith('.zip')) zipBytes = await bytesOf(files[0]);
    else { const b = await bytesOf(files[0]); if (sniff(b) === 'zip') zipBytes = b; }
  }
  if (zipBytes) {
    try {
      const model = await openChartPackage(zipBytes);
      blankDraft();
      scan = scanFiles([]);
      draft.chart = model.chart;
      draft.background = model.background;
      draft.effect = model.effect;
      draft.sfx = model.sfx.slice();
      packageOthers = model.others.slice();
      // 缓存键与 refreshSfxAnalysis 的比较口径一致：file 或 data 本体
      sfxAnalysis = analyzeSfx(new TextDecoder().decode(model.chart.data), model.sfx);
      sfxAnalysisSource = model.chart.file || model.chart.data;
      folderName = name || files[0].name.replace(/\.zip$/i, '');
      difficultyIndex = 0;
      clearTouchedFields();
      imported = true;
      renderAll({ resetPrefill: true });
      return;
    } catch (error) {
      showImportError(`无法读取 ZIP：${error.message}`);
      return;
    }
  }

  const incoming = scanFiles(files);
  if (reset) {
    blankDraft();
    clearTouchedFields();
    difficultyIndex = firstDifficulty(incoming);
    folderName = name || folderName;
  }
  mergeIncoming(incoming, reset);
  videoProbe = draft.video?.file ? await probeVideo(draft.video.file) : null;
  imported = true;
  renderAll({ resetPrefill: reset });
}

async function bytesOf(file) { return new Uint8Array(await file.arrayBuffer()); }
function firstDifficulty(value) {
  const item = value.charts.findIndex(Boolean);
  return item >= 0 ? item : 0;
}

function renderAll({ resetPrefill = false } = {}) {
  resourceBox.hidden = false;
  form.hidden = false;
  renderDifficulties();
  renderResources();
  renderImportNote();
  if (resetPrefill) applyPrefill(true);
  else updateSummary();
  paintCharterHint();
}

function renderDifficulties() {
  const found = availableDifficulties(scan);
  const field = $('diff-field');
  const box = $('difficulties');
  clear(box);
  field.hidden = found.length < 2;
  for (const item of found) {
    const input = el('input', { type: 'radio', name: 'difficulty', value: String(item.index) });
    input.checked = item.index === difficultyIndex;
    input.addEventListener('change', () => {
      difficultyIndex = item.index;
      draft.chart = ref(scan.charts[difficultyIndex]);
      sfxAnalysis = null;
      sfxAnalysisSource = null;
      applyPrefill(false);
      renderResources();
    });
    const candidates = scan.chartCandidates[item.index] || [item.file];
    const pick = el('label', { class: 'diff-pick' }, input, DIFF_NAMES[item.index], el('small', {}, item.file.name));
    pick.style.setProperty('--tier', DIFF_COLORS[item.index]);
    if (candidates.length > 1) {
      const select = el('select', { class: 'select resource-candidates', 'aria-label': `${DIFF_NAMES[item.index]}候选谱面` });
      candidates.forEach((file, candidateIndex) => select.append(el('option', { value: String(candidateIndex) }, file.name)));
      select.addEventListener('click', event => event.stopPropagation());
      select.addEventListener('change', () => {
        scan.charts[item.index] = candidates[Number(select.value)];
        if (item.index === difficultyIndex) { draft.chart = ref(scan.charts[item.index]); sfxAnalysis = null; sfxAnalysisSource = null; renderResources(); }
      });
      pick.append(el('span', { class: 'hint' }, '多个候选'), select);
    }
    box.append(pick);
  }
}

function candidateSelect(kind, selected, onSelect) {
  const choices = scan.candidates[kind] || [];
  if (choices.length < 2) return null;
  const select = el('select', { class: 'select resource-candidates', 'aria-label': '选择候选文件' });
  choices.forEach((file, index) => {
    const option = el('option', { value: String(index) }, `${file.name}（${formatResourceSize(file.size)}）`);
    option.selected = file === selected?.file;
    select.append(option);
  });
  select.addEventListener('change', () => onSelect(choices[Number(select.value)]));
  return el('div', { class: 'resource-candidate-wrap' }, el('span', { class: 'hint' }, '发现多个候选，请确认使用哪一个：'), select);
}

function previewNode(value, kind) {
  if (!value) return null;
  let blob = value.file || null;
  if (!blob && value.data && kind === 'background') blob = new Blob([value.data], { type: 'image/jpeg' });
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  if (kind === 'cover') return thumbImage('cover', url, '封面预览');
  if (kind === 'background') return thumbImage('background', url, '背景图预览');
  if (kind === 'music') return el('audio', { controls: true, preload: 'metadata', src: url });
  if (kind === 'video') return el('video', { controls: true, preload: 'metadata', src: url });
  return null;
}

function renderResources() {
  objectUrls.forEach(url => URL.revokeObjectURL(url));
  objectUrls = [];
  clear(resourceBox);
  resourceBox.append(el('h2', { class: 'section-title' }, '资源清单'), el('p', { class: 'hint resource-intro' }, '自动识别的文件已经填入；任何一项都可以单独替换或移除。预览音频会从当前音乐重新生成。'));

  const rows = [
    ['chart', '谱面', '选中的难度文件；必须提供。', '.aff,.zip', true],
    ['cover', '封面', '会处理成 1024×1024 以内的 JPEG。', 'image/*', true],
    ['music', '音乐', '会转成 OGG Vorbis；更换后试听片段会自动重算。', 'audio/*,.ogg,.mp3,.wav,.flac', true],
    ['background', '背景图', '可选，打进当前谱面资源中。', 'image/*', false],
    ['effect', '演出效果', '可选的 effect.bin。', '.bin', false],
    ['video', '背景视频', '可选，必须是合规的 MP4/H.264。', 'video/mp4,.mp4', false],
  ];

  for (const [kind, label, hint, accept, required] of rows) {
    const current = draft[kind];
    const extra = kind === 'cover' || kind === 'music' || kind === 'background' || kind === 'video'
      ? candidateSelect(kind, current, file => { draft[kind] = ref(file); if (kind === 'music') mountRangeEditor(); renderResources(); })
      : null;
    const row = createResourceRow({
      label, hint, value: current, required, accept,
      preview: previewNode(current, kind),
      onChoose: files => chooseResource(kind, files[0]),
      onRemove: required ? null : () => { draft[kind] = null; if (kind === 'video') videoProbe = null; renderResources(); },
      extra,
    });
    resourceBox.append(row.element);
  }

  const preview = el('div', { class: 'resource-row' });
  const previewSlot = el('div', { class: 'resource-range' });
  preview.append(
    el('div', { class: 'resource-head' }, el('strong', {}, '预览音频'), el('span', { class: 'resource-hint' }, '从音乐自动截取，最长 60 秒；移动两侧手柄或直接修改秒数。')),
    el('div', { class: 'resource-status', id: 'preview-status' }),
    previewSlot,
  );
  resourceBox.append(preview);
  // renderResources 会清空 resourceBox 重建，已经存在的 rangeEditor.element 要重新挂回新槽，
  // 否则 chooseResource('music') 里 await mountRangeEditor 挂上的元素会被紧接着的 renderRows 抹掉
  if (rangeEditor) previewSlot.append(rangeEditor.element);

  const sfx = el('div', { class: 'resource-row' });
  const sfxList = el('div', { class: 'resource-sfx-list' });
  const add = createFilePicker({ accept: '.wav,audio/wav', multiple: true, label: '添加音效', onFiles: files => {
    for (const file of files) draft.sfx.push(ref(file));
    sfxAnalysis = null;
    sfxAnalysisSource = null;
    renderResources();
  }});
  sfx.append(
    el('div', { class: 'resource-head' }, el('strong', {}, `天键音效${draft.sfx.length ? `（${draft.sfx.length} 个）` : ''}`), el('span', { class: 'resource-hint' }, '文件名必须和 AFF 里的 fx 引用对应；可逐个添加和删除。')),
    el('div', { class: 'resource-actions' }, add.button, el('span', { class: 'hint' }, draft.sfx.length ? '已加入列表' : '未提供')),
    sfxList,
  );
  for (const [index, sound] of draft.sfx.entries()) {
    const item = el('div', { class: 'resource-sfx-item' }, el('span', {}, `${sound.name || sound.file?.name || '音效'}${sound.file ? `（${formatResourceSize(sound.file.size)}）` : ''}`));
    const remove = el('button', { class: 'button small ghost', type: 'button' }, '删除');
    remove.addEventListener('click', () => { draft.sfx.splice(index, 1); sfxAnalysis = null; sfxAnalysisSource = null; renderResources(); });
    item.append(remove);
    sfxList.append(item);
  }
  if (sfxAnalysis?.missing.length) sfx.append(el('div', { class: 'callout warning' }, `谱面引用了但当前没有的音效：${sfxAnalysis.missing.join('、')}`));
  if (sfxAnalysis?.unused.length) sfx.append(el('p', { class: 'hint' }, `当前未被谱面引用：${sfxAnalysis.unused.join('、')}`));
  resourceBox.append(sfx);

  updateSummary();
  // 初次显示时挂载波形；mountRangeEditor 完成后会再次 renderResources，不能在每次 render 时递归解码。
  if (draft.music && !rangeEditor && audioSequence === 0) mountRangeEditor();

  if (draft.video && videoProbe && !videoProbe.ok) {
    const note = el('div', { class: 'callout warning' },
      el('strong', {}, videoProbe.reason),
      commandBlock(buildFfmpegCommand(draft.video.file.name), '装了 ffmpeg 的话，用这条命令转成合规的 MP4：'));
    resourceBox.append(note);
  }
  refreshSfxAnalysis();
}

async function refreshSfxAnalysis() {
  const source = draft.chart;
  if (!source) return;
  const key = source.file || source.data;
  if (!key || key === sfxAnalysisSource) return;
  sfxAnalysisSource = key;
  try {
    let chart = source;
    if (source.file) {
      const b = await bytesOf(source.file);
      if (sniff(b) === 'zip') {
        const model = await openChartPackage(b);
        chart = model.chart;
      }
    }
    const data = chart.data || await bytesOf(chart.file);
    sfxAnalysis = analyzeSfx(new TextDecoder().decode(data), draft.sfx);
    if (draft.chart === source) renderResources();
  } catch {
    // 音效校验是辅助提示，解析失败不阻挡上传。
  }
}

async function chooseResource(kind, file) {
  if (!file) return;
  if (kind === 'chart') {
    let zipBytes = null;
    if (file.name.toLowerCase().endsWith('.zip')) zipBytes = await bytesOf(file);
    else { const b = await bytesOf(file); if (sniff(b) === 'zip') zipBytes = b; }
    if (zipBytes) {
      try {
        const model = await openChartPackage(zipBytes);
        draft.chart = model.chart;
        draft.background = model.background;
        draft.effect = model.effect;
        draft.sfx = model.sfx.slice();
        packageOthers = model.others.slice();
        renderResources();
      } catch (error) { showImportError(`无法读取 ZIP：${error.message}`); }
      return;
    }
  }
  draft[kind] = ref(file);
  if (kind === 'chart') { sfxAnalysis = null; sfxAnalysisSource = null; }
  if (kind === 'music') await mountRangeEditor();
  if (kind === 'video') videoProbe = await probeVideo(file);
  renderResources();
}

async function mountRangeEditor() {
  const sequence = ++audioSequence;
  rangeEditor?.destroy();
  rangeEditor = null;
  decodedBuffer = null;
  const status = $('preview-status');
  if (status) status.textContent = '正在解析音乐波形…';
  if (!draft.music?.file) return;
  try {
    const buffer = await decodeAudio(draft.music.file);
    if (sequence !== audioSequence || draft.music?.file === undefined) return;
    decodedBuffer = buffer;
    const startInput = $('previewStart');
    const endInput = $('previewEnd');
    const initial = defaultPreviewRange(buffer.duration);
    const start = Number(startInput.value) || initial.start;
    const end = Number(endInput.value) || initial.end;
    rangeEditor = createPreviewRangeEditor({
      buffer, start, end,
      onChange: range => {
        startInput.value = range.start.toFixed(1);
        endInput.value = range.end.toFixed(1);
        startInput.dataset.touched = '1';
        endInput.dataset.touched = '1';
        updateSummary();
      },
    });
    if (status) status.textContent = '';
    const slot = resourceBox.querySelector('.resource-range');
    if (slot) { clear(slot); slot.append(rangeEditor.element); }
  } catch (error) {
    decodedBuffer = null;
    if (status) status.textContent = `无法解析波形：${error.message}，仍可手动填写试听区间`;
  }
}

async function applyPrefill(reset) {
  const prefill = await buildPrefill(scan, difficultyIndex, folderName);
  const values = {
    levelName: prefill.levelName,
    composerName: prefill.composerName,
    charterName: prefill.charterName,
    artistName: prefill.artistName,
    displayDifficulty: prefill.displayDifficulty,
    baseBpm: prefill.baseBpm ? String(prefill.baseBpm) : '',
    bpm: prefill.bpm,
    previewStart: prefill.previewStart > 0 ? String(prefill.previewStart) : '',
    previewEnd: prefill.previewEnd > 0 ? String(prefill.previewEnd) : '',
  };
  for (const [id, value] of Object.entries(values)) {
    const input = $(id);
    const difficultyField = ['displayDifficulty', 'charterName', 'artistName'].includes(id);
    if (value && (reset || difficultyField || !input.dataset.touched)) input.value = value;
  }
  setThemeColor(prefill.themeColor);
  renderTitleOptions(prefill.titleOptions);
  const sources = [prefill.fromSonglist ? 'songlist' : null, prefill.fromArcade ? 'Arcade 工程文件' : null].filter(Boolean);
  $('songlist-note').hidden = !sources.length;
  $('songlist-note').textContent = sources.length ? `已从 ${sources.join(' 和 ')} 读取曲目信息，请核对后再提交。` : '';
  paintCharterHint();
  if (draft.music) await mountRangeEditor();
  updateSummary();
}

function renderTitleOptions(titles) {
  const box = $('title-options');
  clear(box);
  const entries = Object.entries(titles || {});
  box.hidden = entries.length < 2;
  for (const [locale, value] of entries) {
    const chip = el('button', { type: 'button', class: 'title-option', dataset: { value }, title: value },
      el('span', { class: 'locale' }, LOCALE_LABELS[locale] || locale), el('span', { class: 'value' }, value));
    chip.addEventListener('click', () => { $('levelName').value = value; $('levelName').dataset.touched = '1'; paintTitleOptions(); });
    box.append(chip);
  }
  paintTitleOptions();
}
function paintTitleOptions() { for (const chip of $('title-options').children) chip.classList.toggle('active', chip.dataset.value === $('levelName').value); }
function paintCharterHint() {
  const value = $('charterName').value.trim();
  const hint = $('charter-hint');
  hint.textContent = value && value !== identityName ? `谱师填的是「${value}」，但所有权会归当前身份「${identityName}」。` : '';
  hint.classList.toggle('is-warn', Boolean(value && value !== identityName));
}
function setThemeColor(value) {
  if (!/^#[0-9a-f]{6}$/i.test(value || '')) return;
  $('themeColor').value = value.toUpperCase();
  $('themeSwatch').value = value;
}

function renderImportNote() {
  const parts = [];
  if (scan.songlist) parts.push(`已读取 ${scan.songlist.name}`);
  if (scan.arcadeProject) parts.push(`已读取 ${scan.arcadeProject.name}`);
  if (scan.leftover.length) parts.push(`${scan.leftover.length} 个文件未识别`);
  if (scan.conflicts.length) parts.push(`${scan.conflicts.length} 组候选需要确认`);
  importNote.hidden = !parts.length;
  importNote.className = 'callout';
  clear(importNote);
  importNote.append(el('span', {}, parts.join(' · ')));
  if (scan.leftover.length) {
    const details = el('details', { class: 'unused-files' },
      el('summary', {}, '查看未使用文件'),
      el('ul', {}, ...scan.leftover.map(file => el('li', {}, file.name))));
    importNote.append(details);
  }
}

function showImportError(message) {
  importNote.hidden = false;
  importNote.className = 'callout error';
  importNote.textContent = message;
}

function syncScan() {
  scan.charts[difficultyIndex] = draft.chart?.file || draft.chart || null;
  scan.cover = draft.cover?.file || null;
  scan.music = draft.music?.file || null;
  scan.background = draft.background?.file || null;
  scan.effect = draft.effect?.file || null;
  scan.video = draft.video?.file || null;
  scan.wavs = draft.sfx.filter(item => item.file).map(item => item.file);
}

function buildDraftPackage() {
  return {
    chart: draft.chart,
    background: draft.background,
    effect: draft.effect,
    sfx: draft.sfx,
    others: packageOthers,
  };
}

function missingResources() {
  const missing = [];
  if (!draft.chart) missing.push('谱面');
  if (!draft.cover) missing.push('封面');
  if (!draft.music) missing.push('音乐');
  if (draft.video && videoProbe && !videoProbe.ok) missing.push('合规的背景视频');
  return missing;
}

function updateSummary() {
  const missing = missingResources();
  const actions = [];
  if (draft.chart) actions.push(`上传 ${DIFF_NAMES[difficultyIndex] || '谱面'}`);
  if (draft.background) actions.push('包含背景图');
  if (draft.effect) actions.push('包含演出效果');
  if (draft.sfx.length) actions.push(`${draft.sfx.length} 个天键音效`);
  if (draft.video) actions.push(videoProbe?.ok === false ? 'BGA 待处理' : '包含 BGA');
  $('upload-summary').textContent = missing.length
    ? `还缺少：${missing.join('、')}。${renderChangeSummary(actions)}`
    : `提交内容：${renderChangeSummary(actions)}。预览片段将从音乐自动生成。`;
  $('upload-summary').classList.toggle('is-error', Boolean(missing.length));
}

$('form').addEventListener('submit', async event => {
  event.preventDefault();
  const missing = missingResources();
  if (missing.length) { updateSummary(); return; }
  if (!form.reportValidity()) return;

  const error = $('error');
  const done = $('done');
  const progress = $('progress');
  const progressBar = progress.firstElementChild;
  const stage = $('stage');
  error.hidden = true;
  done.hidden = true;
  $('continue').hidden = true;
  $('submit').disabled = true;
  progress.hidden = false;
  stage.hidden = false;
  progressBar.style.width = '0%';
  // 上传期间停掉试听与波形 rAF，旧版 upload.html 会在 submit 开头 destroy
  rangeEditor?.destroy();
  rangeEditor = null;

  try {
    syncScan();
    const prepared = await prepareChartPackage(buildDraftPackage(), text => { stage.textContent = text; });
    const meta = {
      levelName: value('levelName'), composerName: value('composerName'), charterName: value('charterName'),
      artistName: value('artistName'), displayDifficulty: value('displayDifficulty'),
      baseBpm: Number(value('baseBpm')) || 0, bpm: value('bpm'),
      themeColor: /^#[0-9a-f]{6}$/i.test($('themeColor').value) ? $('themeColor').value : '#4B65B0',
      introduction: value('introduction'), recommendedTheme: value('recommendedTheme'), chartConstant: value('chartConstant'),
      includeVideo: Boolean(draft.video), tags: value('tags').split(/[,，]/).map(item => item.trim()).filter(Boolean),
      previewStart: Number(value('previewStart')), previewEnd: Number(value('previewEnd')),
    };
    const id = await submitLevel(scan, difficultyIndex, meta, (text, ratio) => {
      stage.textContent = text;
      if (typeof ratio === 'number') progressBar.style.width = `${Math.round(ratio * 100)}%`;
    }, { decoded: decodedBuffer, chartBlob: prepared.blob });
    progressBar.style.width = '100%';
    stage.hidden = true;
    done.hidden = false;
    clear(done);
    done.append(el('strong', {}, '上传成功，等待审核。'), el('p', {}, '审核通过后就会出现在社区谱面库里。'), el('p', {}, el('a', { href: `level.html?id=${id}` }, '查看这张谱面 →')));
    $('submit').hidden = true;
    const next = nextDifficulty();
    if (next !== null) {
      $('continue').hidden = false;
      $('continue').textContent = `继续上传 ${DIFF_NAMES[next]}`;
    }
  } catch (reason) {
    error.textContent = describeError(reason);
    error.hidden = false;
    stage.hidden = true;
    progress.hidden = true;
    $('submit').disabled = false;
  }
});

$('continue').addEventListener('click', async () => {
  const next = nextDifficulty();
  if (next === null) return;
  difficultyIndex = next;
  $('continue').hidden = true;
  $('done').hidden = true;
  $('submit').hidden = false;
  $('submit').disabled = false;
  delete $('displayDifficulty').dataset.touched;
  delete $('charterName').dataset.touched;
  delete $('artistName').dataset.touched;
  draft.chart = ref(scan.charts[difficultyIndex]);
  sfxAnalysis = null;
  sfxAnalysisSource = null;
  renderDifficulties();
  await applyPrefill(false);
  renderResources();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

function nextDifficulty() {
  const index = scan.charts.findIndex((file, index) => index > difficultyIndex && file);
  return index >= 0 ? index : null;
}
function value(id) { return $(id).value.trim(); }

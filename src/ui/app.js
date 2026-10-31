const STATUS = { review:{label:'待复核'}, retained:{label:'已保留'}, excluded:{label:'已排除'} };
const TYPES = { target:'目标差距', history:'历史差距', competitor:'竞对差距', industry:'行业差距' };
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let candidates = [], datasets = [], sources = [], runs = [], currentDataset = null, currentRun = null;
let boardView = 'cards', selectedId = null, activeTab = 'overview', lastFocused = null, toastTimer;
const headers = { 'x-sentiscope-client': '1' };

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
function toast(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.add('show');
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3200);
}
function normalizeCandidate(raw) {
  const comparison = raw.comparison;
  return {
    raw, id: raw.id, type: comparison.comparisonType, status: raw.status, title: raw.title,
    gap: comparison.gapDisplay, gapLabel: comparison.reason, interpretation: raw.interpretation, next: raw.nextStep,
    sources: comparison.evidence.length, updated: raw.updatedAt.slice(0,16).replace('T',' '), metric: comparison.metricId,
    entity: comparison.entity, period: comparison.period, actual: `${comparison.actual} ${comparison.unit}`,
    benchmark: `${comparison.benchmark} ${comparison.unit} · ${comparison.benchmarkLabel}`,
    formula: comparison.formula, unknown: raw.unknown, support: raw.support, counter: raw.refutation,
    evidence: comparison.evidence,
    history: [...raw.reviews.map(review => [review.createdAt, `用户${STATUS[review.status].label}：${review.note || '未填写说明'}`]), [raw.createdAt,'候选门禁通过，进入待复核']],
  };
}
const decorated = () => candidates.map(normalizeCandidate);
const statusLabel = status => `<span class="status-text status-${status}">${STATUS[status].label}</span>`;
function visibleCandidates() {
  const query = $('candidate-search').value.trim().toLowerCase(), status = $('status-filter').value;
  return decorated().filter(c => (status === 'all' || c.status === status) && (!query || `${c.title}${c.metric}${c.entity}`.toLowerCase().includes(query)));
}
function card(c) {
  return `<article class="candidate-card" data-id="${c.id}" tabindex="0" aria-label="查看候选 ${escapeHtml(c.title)}"><div class="card-top"><span class="compare-type">${TYPES[c.type]}</span>${statusLabel(c.status)}<span class="card-open">打开</span></div><h2>${escapeHtml(c.title)}</h2><div><div class="gap-number">${escapeHtml(c.gap)}</div><div class="gap-label">${escapeHtml(c.gapLabel)} · ${escapeHtml(c.period)}</div></div><div class="card-section"><div class="card-label">当前解释</div><div class="clamp">${escapeHtml(c.interpretation)}</div></div><div class="card-section next-step"><div class="card-label">下一步</div><div class="clamp">${escapeHtml(c.next)}</div></div><div class="card-footer"><span>${c.sources} 个证据 · 含反证</span><span>${escapeHtml(c.updated)}</span></div></article>`;
}
function renderBoard() {
  const visible = visibleCandidates();
  $('candidate-nav-count').textContent = candidates.length;
  if (boardView === 'cards') {
    $('candidate-board').className = 'candidate-lanes';
    $('candidate-board').innerHTML = Object.keys(STATUS).map(status => {
      const rows = visible.filter(c => c.status === status);
      return `<section><h2 class="lane-title status-${status}">${STATUS[status].label}<span class="lane-count">${rows.length}</span></h2><div class="lane-cards">${rows.length ? rows.map(card).join('') : '<div class="empty-lane">当前筛选无候选</div>'}</div></section>`;
    }).join('');
  } else {
    $('candidate-board').className = 'table-wrap';
    $('candidate-board').innerHTML = `<table class="candidate-table"><thead><tr><th style="width:28%">候选</th><th style="width:12%">类型 / 状态</th><th style="width:16%">差距</th><th style="width:24%">当前解释</th><th style="width:10%">证据</th><th style="width:10%">更新</th></tr></thead><tbody>${visible.map(c => `<tr data-id="${c.id}" tabindex="0"><td><b>${escapeHtml(c.title)}</b><br><span class="muted">${escapeHtml(c.entity)}</span></td><td>${TYPES[c.type]}<br>${statusLabel(c.status)}</td><td><b>${escapeHtml(c.gap)}</b><br><span class="muted">${escapeHtml(c.gapLabel)}</span></td><td>${escapeHtml(c.interpretation)}</td><td>${c.sources} 个<br><span class="muted">含反证</span></td><td>${escapeHtml(c.updated)}</td></tr>`).join('')}</tbody></table>`;
  }
  $('candidate-empty').hidden = visible.length > 0;
}
function overview(c) {
  return `<div class="detail-grid"><section class="detail-section full"><h3>描述性结论</h3><div class="claim">${escapeHtml(c.title)}</div><p class="muted" style="margin-top:10px">只陈述与基准的差距，不推断根因、不预测、不自动创建 Case。</p></section><section class="detail-section"><h3>比较事实</h3><dl class="kv"><dt>指标</dt><dd>${escapeHtml(c.metric)}</dd><dt>实体</dt><dd>${escapeHtml(c.entity)}</dd><dt>周期</dt><dd>${escapeHtml(c.period)}</dd><dt>实际</dt><dd>${escapeHtml(c.actual)}</dd><dt>基准</dt><dd>${escapeHtml(c.benchmark)}</dd></dl></section><section class="detail-section"><h3>未知与限制</h3><p>${escapeHtml(c.unknown)}</p></section><section class="detail-section"><h3>支持证据</h3><p>${escapeHtml(c.support)}</p></section><section class="detail-section"><h3>已检查的反证</h3><p>${escapeHtml(c.counter)}</p></section></div>`;
}
function calculation(c) {
  return `<div class="detail-grid"><section class="detail-section full"><h3>确定性计算</h3><div class="formula">${escapeHtml(c.formula).replaceAll('\n','<br>')}</div><p class="muted" style="margin-top:10px">由比较工具计算并保存输入、公式、输出与工具版本；不是模型心算。</p></section><section class="detail-section"><h3>当前解释</h3><p>${escapeHtml(c.interpretation)}</p></section><section class="detail-section"><h3>下一步</h3><p>${escapeHtml(c.next)}</p></section></div>`;
}
function evidence(c) {
  return `<section class="detail-section"><h3>证据与转换血缘</h3><ul class="evidence-list">${c.evidence.map((ref,index) => `<li><button class="evidence-link" data-evidence-index="${index}"><div class="evidence-role">${escapeHtml(ref.kind)} · 点击查看原始位置</div><div class="evidence-title">${escapeHtml(ref.locator)}</div><div class="evidence-meta">sha256:${escapeHtml(ref.assetSha256)}<br>${escapeHtml(ref.note || '原始资产 → 解析 → 清洗步骤 → 标准数据集 → 比较观察 → 当前候选')}</div></button></li>`).join('')}<li><div class="evidence-role">反证</div><div class="evidence-title">${escapeHtml(c.counter)}</div><div class="evidence-meta">反证不会因候选提交而被删除。</div></li></ul></section>`;
}
function history(c) {
  return `<section class="detail-section"><h3>候选与人工复核历史</h3><ul class="history-list">${c.history.map(([time,text]) => `<li><time>${escapeHtml(time)}</time>${escapeHtml(text)}</li>`).join('')}</ul><p class="muted">人工复核只追加状态事件，不改写观察、证据或原始资产。</p></section>`;
}
function renderDialog() {
  const c = decorated().find(item => item.id === selectedId); if (!c) return;
  $('dialog-type').textContent = TYPES[c.type]; $('dialog-title').textContent = c.title;
  $('dialog-subtitle').textContent = `${STATUS[c.status].label} · ${c.entity} · ${c.period} · ${c.sources} 个证据`;
  $('retain-candidate').disabled = c.status === 'retained'; $('exclude-candidate').disabled = c.status === 'excluded';
  document.querySelectorAll('.dialog-tab').forEach(button => button.classList.toggle('active',button.dataset.tab === activeTab));
  $('dialog-content').innerHTML = activeTab === 'overview' ? overview(c) : activeTab === 'calculation' ? calculation(c) : activeTab === 'evidence' ? evidence(c) : history(c);
}
function openCandidate(id) {
  selectedId = id; activeTab = 'overview'; lastFocused = document.activeElement; renderDialog();
  $('candidate-dialog').showModal(); $('dialog-close').focus();
}
async function review(status) {
  try {
    const note = $('review-note').value.trim();
    const { candidate } = await api(`/api/candidates/${selectedId}/review`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({status,note}) });
    candidates = candidates.map(item => item.id === candidate.id ? candidate : item);
    $('review-note').value = ''; renderBoard(); renderDialog(); toast(`${STATUS[status].label}：复核状态与说明已保存，未创建 Case。`);
  } catch (error) { toast(`复核失败：${error.message}`); }
}
async function openEvidence(index) {
  const c = decorated().find(item => item.id === selectedId); if (!c) return;
  const ref = c.evidence[index]; if (!ref) return;
  $('candidate-dialog').close();
  try {
    if (ref.kind === 'calculation') {
      const comparisonId = ref.locator.startsWith('comparison:') ? ref.locator.slice('comparison:'.length).split(';')[0] : null;
      if (!comparisonId) { toast('计算证据缺少 comparisonId，无法下钻。'); return; }
      const detail = await api(`/api/runs/${c.raw.runId}`);
      const observation = detail.observations.find(item => item.comparisonId === comparisonId && item.comparison);
      if (!observation) { toast(`未找到比较事件 ${comparisonId}，未执行跳转。`); return; }
      setView('exploration'); renderRun(detail.run,detail.observations);
      const eventIndex = detail.run.events.findIndex(event => event.details?.observationId === observation.id);
      const target = eventIndex >= 0 ? $('activity-list').children[eventIndex] : null;
      if (target) { target.classList.add('highlight-target'); target.scrollIntoView({block:'center'}); }
      toast(`计算事件 ${comparisonId}：${observation.comparison.formula}`);
      return;
    }
    const evidenceDataset = datasets.find(dataset => dataset.id === c.raw.datasetId);
    if (!evidenceDataset) { toast('无法找到候选创建时的数据版本，证据下钻已停止。'); return; }
    currentDataset = evidenceDataset;
    if (ref.kind === 'web') {
      setView('sources');
      const card = document.querySelector(`[data-source-sha="${ref.assetSha256}"]`);
      if (!card) { toast('未找到公网快照，证据下钻已停止。'); return; }
      const detail = card.querySelector('details'); if (detail) detail.open = true;
      const locator = document.createElement('p'); locator.className = 'source-meta'; locator.textContent = `候选引用位置：${ref.locator}`; detail?.append(locator);
      const raw = await api(`/api/evidence-text/${ref.assetSha256}`);
      const pre = document.createElement('pre'); pre.className = 'source-meta'; pre.textContent = extractEvidenceSnippet(raw.text,ref.locator); detail?.append(pre);
      card.classList.add('highlight-target'); card.scrollIntoView({block:'center'}); setTimeout(() => card.classList.remove('highlight-target'),2200);
      toast(`已定位公网证据：${ref.locator}`);
      return;
    }
    setView('datasets'); renderDataset();
    const raw = ref.kind === 'raw';
    const rowIndex = raw
      ? currentDataset.rawRows.findIndex(row => row.source.assetSha256 === ref.assetSha256 && row.source.locator === ref.locator)
      : currentDataset.rows.findIndex(row => (row.source.assetSha256 === ref.assetSha256 && row.source.locator === ref.locator) || (row.metricId === c.metric && row.entity === c.entity && row.period === c.period));
    if (rowIndex < 0) { toast('未找到对应数据行，未执行高亮或跳转。'); return; }
    renderPreview(raw ? 'raw' : 'clean',rowIndex);
    if (!raw) $('cleaning-lineage').open = true;
    toast(`已定位证据：${ref.locator}`);
  } catch (error) { toast(`证据下钻失败：${error.message}`); }
}
function extractEvidenceSnippet(text, locator) {
  const documentNode = new DOMParser().parseFromString(text,'text/html');
  const css = /^table#([\w-]+) tr:nth-child\((\d+)\)$/.exec(locator);
  if (css) {
    const row = documentNode.getElementById(css[1])?.querySelectorAll('tr')[Number(css[2]) - 1];
    if (row) return row.textContent.trim();
  }
  const table = /^table:(\d+):row:(\d+)$/.exec(locator);
  if (table) {
    const row = documentNode.querySelectorAll('table')[Number(table[1]) - 1]?.querySelectorAll('tr')[Number(table[2]) - 1];
    if (row) return row.textContent.trim();
  }
  const line = /^row:(\d+)$/.exec(locator);
  if (line) return text.split(/\r?\n/)[Number(line[1]) - 1] ?? '未找到引用行';
  return text.slice(0,500);
}

function setView(name) {
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active',view.id === `view-${name}`));
  document.querySelectorAll('.nav-button').forEach(button => button.classList.toggle('active',button.dataset.nav === name && (name !== 'sources' || button.textContent.includes('内部文件'))));
  const titles = {candidates:'Case 候选',exploration:'探索运行',datasets:'标准数据集',sources:'来源资产'};
  $('topbar-title').textContent = titles[name]; $('app').classList.remove('sidebar-open');
}
function renderPreview(kind, highlightIndex = -1) {
  if (!currentDataset) return;
  const clean = kind === 'clean', rows = clean ? currentDataset.rows : currentDataset.rawRows;
  const heads = clean ? ['指标','实体','期间','数值','单位','质量'] : ['原始字段与值','来源行','问题'];
  $('data-preview-title').textContent = clean ? '标准数据预览' : '原始数据预览';
  $('data-head').innerHTML = `<tr>${heads.map(head => `<th>${head}</th>`).join('')}</tr>`;
  $('data-body').innerHTML = rows.map((row,index) => {
    const cells = clean ? [row.metricId,row.entity,row.period,row.value,row.unit,row.quality] : [Object.entries(row.values).map(([key,value]) => `${key}=${String(value)}`).join(' · '),row.source.locator,row.issues.join(',') || '—'];
    return `<tr class="${index === highlightIndex ? 'highlight-target' : ''}">${cells.map(value => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`;
  }).join('');
  $('lineage-note').textContent = clean ? `数据集 ${currentDataset.id} · ${currentDataset.steps.length} 步可重放清洗 · sha256:${currentDataset.sha256}` : '原始值只读展示；清洗不会覆盖原始资产。';
  document.querySelectorAll('[data-preview]').forEach(button => button.classList.toggle('active',button.dataset.preview === kind));
  if (highlightIndex >= 0) $('data-body').querySelectorAll('tr')[highlightIndex]?.scrollIntoView({block:'center'});
}
function renderDataset() {
  if (!currentDataset) return;
  const info = document.querySelector('#view-datasets .dataset-grid');
  info.innerHTML = `<div class="info-card"><h2>数据集概况</h2><dl class="kv"><dt>标准记录</dt><dd>${currentDataset.rows.length} 行 · ${currentDataset.fields.length} 个原始字段</dd><dt>版本</dt><dd>v${currentDataset.version} · ${escapeHtml(currentDataset.name)}</dd><dt>质量</dt><dd>可用 ${currentDataset.quality.usable} · 隔离 ${currentDataset.quality.blocked} · 待补证 ${currentDataset.quality.needsEvidence}</dd><dt>标准哈希</dt><dd class="mono">${escapeHtml(currentDataset.sha256)}</dd></dl></div><div class="info-card"><h2>来源与处理</h2><dl class="kv"><dt>来源资产</dt><dd>${currentDataset.sourceAssetIds.length} 个</dd><dt>清洗步骤</dt><dd>${currentDataset.steps.length} 步</dd><dt>创建时间</dt><dd>${escapeHtml(currentDataset.createdAt)}</dd></dl></div>`;
  $('cleaning-lineage').innerHTML = `<summary>查看 ${currentDataset.steps.length} 步清洗、参数与版本血缘</summary><ol>${currentDataset.steps.map(step => `<li><b>${escapeHtml(step.kind)} v${step.version}</b> · 参数 ${escapeHtml(JSON.stringify(step.params))}<br>输入 ${escapeHtml(step.inputHash.slice(0,12))}… → 输出 ${escapeHtml(step.outputHash.slice(0,12))}… · 影响 ${step.affectedRows.length} 行</li>`).join('')}</ol>`;
  const banner = document.querySelector('#view-datasets .context-banner');
  banner.innerHTML = `<b>${escapeHtml(currentDataset.name)} · 标准数据集 v${currentDataset.version}</b><span>上游：${currentDataset.sourceAssetIds.length} 个来源资产</span><span>清洗步骤：${currentDataset.steps.length}</span><span>状态：可用于描述性分析</span>`;
  renderPreview('clean');
}
function renderSources() {
  document.querySelector('.source-list').innerHTML = sources.map(asset => `<article class="source-card" data-source-sha="${asset.sha256}"><div><div class="source-kind">${asset.kind === 'web' ? '公网快照' : '用户文件'}</div><h2>${escapeHtml(asset.name)}</h2><div class="source-meta">${asset.kind === 'web' ? `发布 ${escapeHtml(asset.publishedAt || '未知')} · 抓取 ${escapeHtml(asset.capturedAt || asset.importedAt)}` : `导入 ${escapeHtml(asset.importedAt)}`} · sha256:${escapeHtml(asset.sha256.slice(0,16))}…</div><details><summary>查看来源定位与原始证据</summary><p class="source-meta">${escapeHtml(asset.locator)}</p><a class="btn small" href="/api/evidence/${asset.sha256}" download>下载原始证据</a></details></div><div class="source-status">原始字节已保存<br>${escapeHtml(asset.mediaType)}</div></article>`).join('');
  $('file-list').innerHTML = sources.map(asset => `<li><div class="file-name">${escapeHtml(asset.name)}</div><div class="file-meta">${asset.kind === 'web' ? '公网快照' : '用户文件'} · ${escapeHtml(asset.sha256.slice(0,12))}…</div></li>`).join('');
}
function renderRun(run, observations = []) {
  currentRun = run;
  $('cancel-run').hidden = run.status !== 'running';
  const needs = observations.filter(observation => observation.status === 'needs_evidence').length;
  const types = new Set(observations.map(observation => observation.comparison?.comparisonType).filter(Boolean));
  $('run-summary').innerHTML = `<div class="summary-item"><strong>${types.size}</strong><span>比较类型已检查</span></div><div class="summary-item"><strong>${run.candidateIds.length}</strong><span>候选通过门禁</span></div><div class="summary-item"><strong>${needs}</strong><span>补证项，仅留观察</span></div><div class="summary-item"><strong>0</strong><span>自动创建 Case / Project</span></div>`;
  $('activity-list').innerHTML = run.events.map(event => `<li><time class="activity-time">${escapeHtml(event.at.slice(11,19))}</time><div><div class="activity-title"><span class="tool-pill">${escapeHtml(event.type)}</span>${escapeHtml(event.summary)}</div><div class="activity-detail">${escapeHtml(JSON.stringify(event.details || {}))}</div></div></li>`).join('');
  $('stop-reason').textContent = `${run.status} · ${run.stopReason}`;
  const banner = document.querySelector('#view-exploration .context-banner');
  banner.innerHTML = `<b>${escapeHtml(run.datasetId)}</b><span>模型：${escapeHtml(run.model)}</span><span>工具预算：${run.budget.usedToolCalls} / ${run.budget.maxToolCalls}</span><span>状态：${escapeHtml(run.status)}</span>`;
  document.querySelector('.activity-head span').textContent = `运行 ${run.id} · ${run.status}`;
}
async function loadCandidates() { candidates = (await api('/api/candidates')).candidates; renderBoard(); }
async function loadDatasets() {
  datasets = (await api('/api/datasets')).datasets; currentDataset = datasets[0] || null;
  document.querySelector('[data-nav="datasets"] .nav-count').textContent = datasets.length;
  renderDataset();
}
async function loadSources() {
  sources = (await api('/api/sources')).sources;
  document.querySelectorAll('[data-nav="sources"]').forEach(button => {
    const kind = button.textContent.includes('公网') ? 'web' : 'file';
    button.querySelector('.nav-count').textContent = sources.filter(source => source.kind === kind).length;
  });
  renderSources();
}
async function loadRuns() {
  runs = (await api('/api/runs')).runs;
  document.querySelector('.nav-button[data-nav="exploration"] .nav-count').textContent = runs.length;
  if (runs[0]) { const detail = await api(`/api/runs/${runs[0].id}`); renderRun(detail.run,detail.observations); }
}
async function startRun(mode) {
  try {
    const { runId } = await api('/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode})});
    setView('exploration'); toast('探索已启动，正在读取真实运行状态…');
    let finished = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const detail = await api(`/api/runs/${runId}`); renderRun(detail.run,detail.observations);
      if (detail.run.status !== 'running') { finished = true; break; }
      await new Promise(resolve => setTimeout(resolve,200));
    }
    if (finished) { await Promise.all([loadCandidates(),loadRuns()]); toast('探索运行已结束，候选与观察已更新。'); }
    else toast('探索仍在运行；可稍后刷新，不会将超时当作完成。');
  } catch (error) { toast(`探索失败：${error.message}`); }
}
function toggleImport(open) { $('app').classList.toggle('import-open',open); }

$('candidate-board').addEventListener('click',event => { const item = event.target.closest('[data-id]'); if (item) openCandidate(item.dataset.id); });
$('candidate-board').addEventListener('keydown',event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-id]')) { event.preventDefault(); openCandidate(event.target.dataset.id); } });
$('candidate-search').addEventListener('input',renderBoard); $('status-filter').addEventListener('change',renderBoard);
document.querySelectorAll('[data-board-view]').forEach(button => button.addEventListener('click',() => { boardView = button.dataset.boardView; document.querySelectorAll('[data-board-view]').forEach(item => item.classList.toggle('active',item === button)); renderBoard(); }));
document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click',() => setView(button.dataset.nav)));
$('dialog-close').addEventListener('click',() => $('candidate-dialog').close());
$('candidate-dialog').addEventListener('close',() => { if (lastFocused) lastFocused.focus(); });
$('retain-candidate').addEventListener('click',() => review('retained')); $('exclude-candidate').addEventListener('click',() => review('excluded'));
document.querySelectorAll('.dialog-tab').forEach(button => button.addEventListener('click',() => { activeTab = button.dataset.tab; renderDialog(); }));
$('dialog-content').addEventListener('click',event => { const button = event.target.closest('[data-evidence-index]'); if (button) openEvidence(Number(button.dataset.evidenceIndex)); });
document.querySelectorAll('[data-preview]').forEach(button => button.addEventListener('click',() => renderPreview(button.dataset.preview)));
$('theme-toggle').addEventListener('click',() => { const dark = $('app').dataset.theme !== 'dark'; $('app').dataset.theme = dark ? 'dark' : 'light'; $('theme-toggle').textContent = dark ? '浅色' : '深色'; $('theme-toggle').setAttribute('aria-pressed',String(dark)); });
$('sidebar-toggle').addEventListener('click',() => { if (window.innerWidth > 760) { const collapsed = $('app').classList.toggle('sidebar-collapsed'); $('sidebar-toggle').setAttribute('aria-expanded',String(!collapsed)); } else { const open = $('app').classList.toggle('sidebar-open'); $('sidebar-toggle').setAttribute('aria-expanded',String(open)); } });
$('import-toggle').addEventListener('click',() => $('app').classList.toggle('import-open')); $('import-main').addEventListener('click',() => toggleImport(true)); $('import-close').addEventListener('click',() => toggleImport(false)); document.querySelectorAll('[data-open-import]').forEach(button => button.addEventListener('click',() => toggleImport(true)));
$('demo-import').textContent = '选择 CSV / XLSX';
$('demo-import').addEventListener('click',() => {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.csv,.xlsx';
  input.addEventListener('change',async () => {
    const file = input.files?.[0]; if (!file) return;
    try {
      toast(`正在导入 ${file.name}…`);
      await api('/api/imports',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':encodeURIComponent(file.name)},body:file});
      await Promise.all([loadDatasets(),loadSources()]); setView('datasets'); toast('文件已导入并生成标准数据集。');
    } catch (error) { toast(`导入失败：${error.message}`); }
  });
  input.click();
});
$('demo-web').textContent = '添加授权公网来源';
$('demo-web').addEventListener('click',async () => {
  const url = window.prompt('输入已获授权的公开 URL（Host 将按白名单与安全策略校验）'); if (!url) return;
  if (!window.confirm('确认该来源允许自动读取，且请求不包含任何内部数据？')) return;
  const metricId = window.prompt('对比指标 ID','revenue.growth'); if (!metricId) return;
  const entity = window.prompt('基准实体（例如：竞对A 或 行业）','竞对A'); if (!entity) return;
  const period = window.prompt('比较期间（例如：2026Q3）','2026Q3'); if (!period) return;
  const unit = window.prompt('数值单位','%'); if (!unit) return;
  const valueHeader = window.prompt('表格中的数值列标题','增速'); if (!valueHeader) return;
  const scope = window.prompt('公开数据的披露范围','同一细分市场与季度'); if (!scope) return;
  const currency = window.prompt('币种','CNY'); if (!currency) return;
  const region = window.prompt('地域范围','同一地域'); if (!region) return;
  const sourceType = window.prompt('来源等级：primary（一手）或 secondary（二手）','primary'); if (!['primary','secondary'].includes(sourceType)) return;
  const periodClosed = window.confirm('该公开数据的比较期间是否已完整结束？仅确认后可用于已结期比较。');
  try {
    await api('/api/public-sources',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,termsConfirmed:true,mapping:{metricId,entity,period,unit,valueHeader,periodClosed,scope,currency,region,sourceType}})});
    await Promise.all([loadSources(),loadDatasets()]); toast('公网快照与标准对比数据已保存。');
  } catch (error) { toast(`公网采集未执行：${error.message}`); }
});
$('cancel-run').addEventListener('click',async () => { if (!currentRun) return; try { await api(`/api/runs/${currentRun.id}/cancel`,{method:'POST'}); toast('已请求取消，等待运行状态落库。'); } catch (error) { toast(`取消失败：${error.message}`); } });
$('replay-run').textContent = '运行合成探索'; $('replay-run').addEventListener('click',() => startRun('qualified'));
$('zero-run-toggle').textContent = '运行零候选样例'; $('zero-run-toggle').addEventListener('click',() => startRun('zero'));
$('help-button').addEventListener('click',() => toast('导入与公网数据 → 可重放清洗 → 描述性探索 → Case 候选。'));
function syncSidebarState() { $('sidebar-toggle').setAttribute('aria-expanded',String(window.innerWidth > 760 ? !$('app').classList.contains('sidebar-collapsed') : $('app').classList.contains('sidebar-open'))); }
window.addEventListener('resize',syncSidebarState); syncSidebarState();
$('candidate-board').innerHTML = '<div class="empty-state">正在加载本机工作区…</div>';
document.querySelector('.source-list').innerHTML = '';
document.querySelector('#view-datasets .dataset-grid').innerHTML = '';
$('activity-list').innerHTML = ''; $('run-summary').innerHTML = '';
Promise.all([loadCandidates(),loadDatasets(),loadSources(),loadRuns()]).catch(error => toast(`工作区加载失败：${error.message}`));

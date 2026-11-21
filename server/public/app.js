'use strict';

const API = '/api/v1/admin';
const pages = {
  devices: { title: '设备', create: '注册设备', empty: '暂无设备', help: '手工注册设备后，将设备 ID、令牌和服务地址填入设备配置。' },
  channels: { title: '渠道', create: '添加渠道', empty: '暂无渠道', help: '添加接收转发消息的渠道。' },
  templates: { title: '模板', create: '新建自定义模板', empty: '暂无自定义模板', help: '通常使用上方的事件默认模板即可；需要多个规则共用格式时，再新建自定义模板。' },
  rules: { title: '规则', create: '新建规则', empty: '暂无规则', help: '添加规则，为设备事件指定接收渠道。' },
  events: { title: '事件' },
  sms: { title: '短信', create: '新短信', empty: '暂无短信', help: '设备收到的短信和通过 SIM 发送的短信会显示在这里。' },
  jobs: { title: '计划任务', create: '新建任务', empty: '暂无计划任务', help: '可定时推送消息、汇总设备状态或发送离线提醒。' },
};
const resourceNames = { devices: '设备', channels: '渠道', templates: '模板', rules: '规则', jobs: '任务' };
const jobKinds = { message: '定时推送', status: '设备状态汇总', offline: '设备离线提醒' };
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const statuses = {
  delivered: ['已送达', 'positive'],
  sent: ['已送达', 'positive'],
  pending: ['待送达', 'active'],
  retry: ['等待重试', 'waiting'],
  failed: ['送达失败', 'negative'],
  mixed: ['部分送达', 'waiting'],
  unrouted: ['未分配渠道', ''],
  online: ['在线', 'positive'],
  offline: ['离线', 'negative'],
};
const smsStatuses = {
  received: ['接收', 'positive'],
  queued: ['等待设备', 'waiting'],
  dispatched: ['提交中', 'active'],
  submitted: ['已提交', 'positive'],
  failed: ['失败', 'negative'],
  unknown: ['结果未知', 'waiting'],
  expired: ['已过期', ''],
  cancelled: ['已取消', ''],
};
const smsDirections = [
  { value: '', label: '全部' }, { value: 'incoming', label: '收件箱' }, { value: 'outgoing', label: '发件箱' },
];
const SMS_STATUS_REFRESH_MS = 5000;
const DEVICE_STATUS_REFRESH_MS = 60_000;
const HISTORY_CLEANUP_BATCH_LIMIT = 20;
const emptySmsFilters = () => ({ device_id: '', q: '', direction: '', status: '', from: '', to: '' });
const dataLabels = {
  sender: '发件号码', number: '号码', content: '正文', text: '内容', sms_time: '短信原始时间', sim_slot: 'SIM 槽位',
  reason: '开机原因', job_id: '任务 ID', job_name: '任务名称', operator: '运营商',
  network_state: '网络状态', rsrp_dbm: '信号强度（dBm）', uptime_seconds: '开机时长（秒）',
  location: '位置', lat: '纬度', lng: '经度', traffic: '流量',
  uplink_bytes: '上行流量（B）', downlink_bytes: '下行流量（B）',
};
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

const byId = (id) => document.getElementById(id);
const ui = {
  auth: byId('auth'), authTitle: byId('auth-title'), authStatus: byId('auth-status'),
  loginForm: byId('login-form'), password: byId('login-password'), loginError: byId('auth-error'),
  loginSubmit: byId('login-submit'), console: byId('console'), logout: byId('logout'),
  title: byId('page-title'), content: byId('page-content'), refresh: byId('refresh'), create: byId('create'), retention: byId('retention'),
  dialog: byId('operation-dialog'), dialogTitle: byId('dialog-title'), dialogContent: byId('dialog-content'),
  dialogClose: byId('dialog-close'), notice: byId('notice'),
};
const state = {
  session: 0, meta: null, view: null, choices: new Map(), filters: { device_id: '', type: '' },
  smsFilters: emptySmsFilters(), dialogBusy: false, dialogOpener: null, pageHidden: false, historyDialog: null,
};
let fieldSequence = 0;
let noticeTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(text, className = '') {
  const node = element('button', `button ${className}`.trim(), text);
  node.type = 'button';
  return node;
}

function record(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function labelFor(dictionary, key) {
  return Object.hasOwn(dictionary, key) ? dictionary[key] : key;
}

function inputValue(value = '', type = 'text') {
  const node = element('input');
  node.type = type;
  node.value = value ?? '';
  return node;
}

function textarea(value = '', rows = 4) {
  const node = element('textarea');
  node.rows = rows;
  node.value = value ?? '';
  return node;
}

function field(labelText, control, { note, wide = false } = {}) {
  const box = element('div', wide ? 'field form-wide' : 'field');
  const label = element('label', '', labelText);
  control.id = `field-${++fieldSequence}`;
  label.htmlFor = control.id;
  box.append(label, control);
  if (note) {
    const hint = element('p', 'field-note', note);
    hint.id = `${control.id}-note`;
    control.setAttribute('aria-describedby', hint.id);
    box.append(hint);
  }
  return box;
}

function group(title, note) {
  const set = element('fieldset', 'form-group form-wide');
  set.append(element('legend', '', title));
  if (note) set.append(element('p', 'field-note', note));
  return set;
}

function checkbox(labelText, checked) {
  const node = element('input');
  node.type = 'checkbox';
  node.checked = checked;
  const label = element('label', 'check-field');
  label.append(node, element('span', '', labelText));
  return { node, label };
}

function selectOptions(select, options, value, placeholder) {
  const selected = value == null ? '' : String(value);
  const choices = options.slice();
  if (selected && !choices.some((option) => String(option.value) === selected)) {
    choices.push({ value: selected, label: `${selected}（不可用）` });
  }
  if (placeholder != null) choices.unshift({ value: '', label: placeholder });
  select.replaceChildren(...choices.map(({ value, label }) => {
    const option = element('option', '', label);
    option.value = String(value);
    return option;
  }));
  if (selected || placeholder != null) select.value = selected;
  return select;
}

function selectValue(options, value, placeholder) {
  return selectOptions(element('select'), options, value, placeholder);
}

function multiChoice(title, options, values, { note, empty = '暂无可选项。' } = {}) {
  const set = group(title, note);
  const boxes = element('div', 'check-options');
  const chosen = new Set((values ?? []).map(String));
  const choices = options.slice();
  for (const value of chosen) {
    if (!choices.some((option) => String(option.value) === value)) choices.push({ value, label: `${value}（不可用）` });
  }
  const entries = choices.map(({ value, label }) => {
    const check = checkbox(label, chosen.has(String(value)));
    boxes.append(check.label);
    return { value, input: check.node };
  });
  set.append(entries.length ? boxes : element('p', 'field-note', empty));
  return { set, values: () => entries.filter(({ input }) => input.checked).map(({ value }) => value) };
}

function errorRegion() {
  const error = element('p', 'inline-error');
  error.role = 'alert';
  error.hidden = true;
  return error;
}

function showError(node, message = '') {
  node.hidden = !message;
  node.textContent = message;
}

function notify(message, isError = false) {
  clearTimeout(noticeTimer);
  ui.notice.classList.toggle('is-error', isError);
  ui.notice.hidden = !message;
  ui.notice.textContent = message;
  if (message) noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, isError ? 7500 : 4300);
}

async function request(path, { method = 'GET', body, checkSession = true, signal } = {}) {
  const session = state.session;
  const headers = { Accept: 'application/json' };
  const options = { method, headers, credentials: 'same-origin', cache: 'no-store', signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${API}${path}`, options);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('无法连接管理服务，请重试。');
  }
  let payload;
  try {
    const text = await response.text();
    signal?.throwIfAborted();
    payload = text ? JSON.parse(text) : {};
  } catch (error) {
    if (signal?.aborted) throw error;
    if (response.ok) throw new Error('管理服务返回了无效的响应。');
  }
  if (!response.ok || payload?.ok === false) {
    if (response.status === 401 && checkSession && state.meta && session === state.session) {
      showLogin('会话已过期，请重新登录。');
    }
    const detail = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
    const statusText = response.ok ? '' : `（HTTP ${response.status}）`;
    throw Object.assign(new Error(detail || `请求失败${statusText}。`), { status: response.status });
  }
  return payload;
}

function showLogin(message = '') {
  const returning = Boolean(state.meta);
  disposeHistoryDialog();
  stopSmsStatusRefresh(state.view, true);
  stopDeviceStatusRefresh(state.view);
  state.session++;
  state.meta = null;
  state.view = null;
  state.choices.clear();
  state.filters = { device_id: '', type: '' };
  state.smsFilters = emptySmsFilters();
  setDialogBusy(false);
  if (ui.dialog.open) ui.dialog.close();
  ui.dialogContent.replaceChildren();
  ui.console.hidden = true;
  ui.content.replaceChildren();
  ui.auth.hidden = false;
  ui.authStatus.hidden = true;
  ui.loginForm.hidden = false;
  ui.password.value = '';
  showError(ui.loginError, message);
  notify('');
  if (returning) ui.authTitle.focus();
}

function activate(meta, focus = false) {
  state.session++;
  state.meta = meta;
  ui.auth.hidden = true;
  ui.console.hidden = false;
  openView(focus);
}

async function checkSession() {
  try {
    activate(await request('/meta', { checkSession: false }));
  } catch (error) {
    showLogin(error.status === 401 ? '' : error.message);
  }
}

function pathFor(resource, id) {
  const path = `/${resource}`;
  return id == null ? path : `${path}/${encodeURIComponent(id)}`;
}

async function listPage(resource, cursor, filters = {}, signal) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  if (cursor) query.set('cursor', cursor);
  const tail = query.toString();
  const page = await request(`${pathFor(resource)}${tail ? `?${tail}` : ''}`, { signal });
  if (!Array.isArray(page?.items)) throw new Error('管理服务未返回列表。');
  return page;
}

function allChoices(resource) {
  if (state.choices.has(resource)) return state.choices.get(resource);
  const session = state.session;
  const load = (async () => {
    const options = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const page = await listPage(resource, cursor);
      if (session !== state.session) return [];
      for (const item of page.items) {
        const identity = resource === 'devices' ? deviceIdentity(item) : '';
        const name = item.name || identity || item.id;
        const label = identity && identity !== name ? `${name}（${identity}）` : name;
        options.set(item.id, { value: item.id, label, ...(resource === 'devices' ? { enabled: Boolean(item.enabled) } : {}) });
      }
      cursor = page.cursor;
      if (cursor && cursors.has(cursor)) throw new Error('管理服务未能加载完整列表，请重试。');
      cursors.add(cursor);
    } while (cursor);
    return [...options.values()];
  })();
  state.choices.set(resource, load);
  const clear = () => {
    if (state.choices.get(resource) === load) state.choices.delete(resource);
  };
  // Devices can enroll while the console is open.
  if (resource === 'devices') load.then(clear, clear);
  else load.catch(clear);
  return load;
}

function eventTypes() {
  return (state.meta?.event_types ?? []).map(({ id, label }) => ({ value: id, label: label || id }));
}

function eventLabel(type) {
  return eventTypes().find(({ value }) => value === type)?.label || type;
}

function channelTypes() {
  return state.meta?.channel_types ?? {};
}

function channelTypeLabel(type) {
  return labelFor(channelTypes(), type)?.label || type;
}

function showTime(value, empty = '—') {
  if (value == null || value === '') return element('span', 'muted', empty);
  const date = typeof value === 'number' ? new Date(value < 1e11 ? value * 1000 : value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return element('span', 'time-text', value);
  const time = element('time', 'time-text', dateFormatter.format(date));
  time.dateTime = date.toISOString();
  return time;
}

function badge(text, tone) {
  return element('span', tone ? `status status--${tone}` : 'status', text);
}

function statusBadge(value) {
  if (!value) return element('span', 'muted', '—');
  return badge(...(Object.hasOwn(statuses, value) ? statuses[value] : [value, '']));
}

function titledCell(title, subtitle, technical = false) {
  const cell = element('div');
  cell.append(element('span', 'cell-title', title));
  if (subtitle) cell.append(element('span', technical ? 'cell-subtitle id-text' : 'cell-subtitle', subtitle));
  return cell;
}

function table(view, columns) {
  const scroll = element('div', 'table-scroll');
  const tableNode = element('table', `data-table${view.name === 'events' ? ' event-table' : view.name === 'sms' ? ' sms-table' : ''}`);
  tableNode.role = 'table';
  tableNode.setAttribute('aria-label', `${pages[view.name].title}列表`);
  const head = element('thead');
  head.role = 'rowgroup';
  const header = element('tr');
  header.role = 'row';
  for (const name of columns) {
    const cell = element('th', '', name);
    cell.role = 'columnheader';
    cell.scope = 'col';
    header.append(cell);
  }
  head.append(header);
  const body = element('tbody');
  body.role = 'rowgroup';
  tableNode.append(head, body);
  scroll.append(tableNode);
  return { scroll, body };
}

function tableRow(body, columns, values) {
  const row = element('tr');
  row.role = 'row';
  values.forEach((value, index) => {
    const last = columns[index] === '操作';
    const cell = element('td', last ? 'actions-cell' : '');
    cell.role = 'cell';
    if (index > 0 && !last) cell.dataset.label = columns[index];
    cell.append(value);
    row.append(cell);
  });
  body.append(row);
  return row;
}

function blankState(title, help) {
  const blank = element('div', 'blank-state');
  blank.append(element('p', 'blank-title', title));
  if (help) blank.append(element('p', 'muted', help));
  return blank;
}

function openView(focus = false) {
  const route = window.location.hash.slice(1);
  const name = Object.hasOwn(pages, route) ? route : 'events';
  if (state.view?.name === name) return;
  if (state.historyDialog) {
    disposeHistoryDialog();
    if (ui.dialog.open) ui.dialog.close();
  }
  stopSmsStatusRefresh(state.view, true);
  stopDeviceStatusRefresh(state.view);
  const view = { name, items: [], cursor: null, loading: false, read: 0, error: '' };
  state.view = view;
  ui.title.textContent = pages[name].title;
  ui.retention.hidden = name !== 'events' && name !== 'sms';
  ui.create.hidden = !pages[name].create;
  ui.create.textContent = pages[name].create || '';
  for (const link of document.querySelectorAll('.site-nav a')) {
    if (link.dataset.view === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  const surface = element('div', 'surface');
  const list = element('section', 'list-panel');
  list.setAttribute('aria-label', `${pages[name].title}记录`);
  view.banner = errorRegion();
  view.banner.classList.add('list-banner');
  view.listBody = element('div');
  view.more = button('加载更多');
  view.more.addEventListener('click', () => {
    if (view.cursor && !view.loading) loadList(view, true);
  });
  view.pagination = element('div', 'pagination');
  view.pagination.hidden = true;
  view.pagination.append(view.more);
  if (name === 'devices') {
    list.append(element('p', 'list-banner field-note',
      `将 ${window.location.origin} 填入设备的 SERVER_URL，设备首次接入时会自动登记并启用。`));
  }
  list.append(view.banner, view.listBody, view.pagination);
  view.list = list;
  if (name === 'events') buildEventWorkspace(view, surface);
  else if (name === 'sms') buildSmsWorkspace(view, surface);
  else if (name === 'templates') buildTemplateWorkspace(view, surface);
  else surface.append(list);
  ui.content.replaceChildren(surface);
  if (focus && !ui.dialog.open) {
    ui.title.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  loadList(view);
}

function entryKey(item, view) {
  return view.name === 'events' ? JSON.stringify([item.device_id, item.event_id]) : String(item.id);
}

function listBusy(view) {
  view.list.setAttribute('aria-busy', String(view.loading));
  ui.refresh.disabled = view.loading;
  view.more.setAttribute('aria-disabled', String(view.loading));
  view.more.disabled = view.loading;
  view.more.textContent = view.loading ? '加载中…' : '加载更多';
}

async function loadList(view, append = false) {
  if (state.view !== view) return;
  if (view.name === 'templates' && !append) loadEventTemplates(view);
  const controller = view.name === 'sms' ? new AbortController() : null;
  if (controller) {
    stopSmsStatusRefresh(view, true);
    view.smsListRequest = controller;
  }
  const read = ++view.read;
  const cursor = append ? view.cursor : null;
  view.loading = true;
  view.error = '';
  showError(view.banner);
  if (!view.items.length) {
    const loading = blankState('正在加载…');
    loading.role = 'status';
    view.listBody.replaceChildren(loading);
  }
  listBusy(view);
  try {
    const filters = view.name === 'events' ? state.filters : view.name === 'sms' ? smsQueryFilters(state.smsFilters) : {};
    const page = await listPage(view.name, cursor, filters, controller?.signal);
    if (state.view !== view || read !== view.read) return;
    const entries = new Map((append ? view.items : []).map((item) => [entryKey(item, view), item]));
    for (const item of page.items) entries.set(entryKey(item, view), item);
    view.items = [...entries.values()];
    view.cursor = page.cursor && page.cursor !== cursor ? page.cursor : null;
  } catch (error) {
    if (state.view !== view || read !== view.read) return;
    view.error = error.message;
  } finally {
    if (state.view === view && read === view.read) {
      if (controller) view.smsListRequest = null;
      view.loading = false;
      listBusy(view);
      renderList(view);
      if (view.name === 'sms' && view.selected?.refreshAfterList) {
        loadSmsDetail(view, view.selected, false);
      }
      syncDeviceStatusRefresh(view);
    }
  }
}

function renderList(view) {
  const active = document.activeElement;
  const focused = view.listBody.contains(active) && active.dataset.recordKey ? active.dataset : null;
  const hasFilters = view.name === 'events' && (state.filters.device_id || state.filters.type);
  const page = pages[view.name];
  showError(view.banner, view.error);
  view.eventRows?.clear();
  view.smsRows?.clear();
  if (view.items.length) {
    view.listBody.replaceChildren(view.name === 'events' ? eventTable(view) : view.name === 'sms' ? smsTable(view) : resourceTable(view));
  } else if (view.error) {
    view.listBody.replaceChildren(blankState('无法加载记录', '请点击刷新重试。'));
  } else if (view.cursor) {
    view.listBody.replaceChildren(blankState('本页没有可显示的记录', '可继续加载下一页。'));
  } else if (view.name === 'events') {
    renderEmptyEvents(view, hasFilters);
  } else if (view.name === 'sms') {
    renderEmptySms(view);
  } else {
    view.listBody.replaceChildren(blankState(page.empty, page.help));
  }
  if (view.smsCount) syncSmsStatusRefresh(view);
  view.pagination.hidden = !view.cursor;
  if (focused) {
    const match = [...view.listBody.querySelectorAll('[data-record-key]')].find((node) =>
      node.dataset.recordKey === focused.recordKey && node.dataset.action === focused.action);
    (match ?? ui.title).focus({ preventScroll: true });
  } else if (active === view.more && view.pagination.hidden) {
    ui.title.focus({ preventScroll: true });
  }
}

function renderEmptyEvents(view, hasFilters) {
  let content;
  if (hasFilters) {
    content = blankState('没有符合筛选条件的事件');
  } else if (view.deviceCount === 0) {
    content = blankState('暂无事件', '设备接入后，可设置接收渠道和转发规则。');
    const link = element('a', 'button button--primary', '前往设备');
    link.href = '#devices';
    content.append(link);
  } else {
    content = blankState('暂无事件', '设备上报后，事件会显示在这里。');
  }
  view.listBody.replaceChildren(content);
}

function buildTemplateWorkspace(view, surface) {
  surface.classList.add('templates-workspace');
  const defaults = element('section', 'template-section');
  defaults.setAttribute('aria-labelledby', 'event-templates-title');
  const heading = element('header', 'template-section-heading');
  const title = element('h2', '', '事件默认模板');
  title.id = 'event-templates-title';
  heading.append(title, element('p', 'field-note', '每种事件分别保存。修改或恢复一项，不会改变其他事件的格式。'));
  const note = element('p', 'template-guidance', '规则选择「按事件使用默认模板」才会使用这里的格式。若旧规则绑定了短信自定义模板，请改用事件默认，或将规则范围限制为「收到短信」。');
  const rules = element('a', '', '前往规则设置');
  rules.href = '#rules';
  note.append(document.createTextNode(' '), rules);
  view.eventTemplateError = errorRegion();
  view.eventTemplateError.classList.add('list-banner');
  view.eventTemplateBody = element('div');
  view.eventTemplateRead = 0;
  defaults.append(heading, note, view.eventTemplateError, view.eventTemplateBody);
  const customHeading = element('header', 'template-section-heading');
  const customTitle = element('h2', '', '共用自定义模板');
  customTitle.id = 'custom-templates-title';
  customHeading.append(customTitle, element('p', 'field-note', '同一模板可被多个规则或任务共用，修改会影响所有引用；样本事件只用于预览。'));
  view.list.setAttribute('aria-labelledby', customTitle.id);
  view.list.prepend(customHeading);
  view.list.classList.add('template-section');
  surface.append(defaults, view.list);
}

async function loadEventTemplates(view) {
  const read = ++view.eventTemplateRead;
  const current = () => state.view === view && read === view.eventTemplateRead;
  view.eventTemplateBody.setAttribute('aria-busy', 'true');
  showError(view.eventTemplateError);
  if (!view.eventTemplates) view.eventTemplateBody.replaceChildren(blankState('正在加载事件默认模板…'));
  try {
    const result = await request('/event-templates');
    if (!current()) return;
    const types = eventTypes();
    if (!Array.isArray(result?.items) || result.items.length !== types.length || new Set(result.items.map((item) => item?.id)).size !== types.length
        || result.items.some((item) => !record(item) || !types.some(({ value }) => value === item.id)
          || typeof item.title !== 'string' || typeof item.body !== 'string' || typeof item.customized !== 'boolean'
          || !record(item.defaults) || typeof item.defaults.title !== 'string' || typeof item.defaults.body !== 'string')) {
      throw new Error('管理服务未返回完整的事件默认模板，请刷新重试。');
    }
    view.eventTemplates = result.items;
    renderEventTemplates(view);
  } catch (failure) {
    if (!current()) return;
    showError(view.eventTemplateError, failure.message);
    if (!view.eventTemplates) view.eventTemplateBody.replaceChildren(blankState('无法加载事件默认模板', '请点击刷新重试。'));
  } finally {
    if (current()) view.eventTemplateBody.setAttribute('aria-busy', 'false');
  }
}

function renderEventTemplates(view) {
  const active = document.activeElement;
  const focused = view.eventTemplateBody.contains(active) ? active.dataset : null;
  const columns = ['事件', '标题', '正文', '操作'];
  const { scroll, body } = table(view, columns);
  const node = scroll.querySelector('table');
  node.classList.add('event-template-table');
  node.setAttribute('aria-label', '事件默认模板列表');
  for (const item of view.eventTemplates) {
    const name = titledCell(item.label || eventLabel(item.id), item.id, true);
    name.append(badge(item.customized ? '已修改' : '内置默认', item.customized ? 'positive' : ''));
    const actions = element('div', 'row-actions');
    const edit = button('编辑', 'button--quiet');
    edit.setAttribute('aria-label', `编辑 ${item.label || eventLabel(item.id)}默认模板`);
    edit.dataset.recordKey = item.id;
    edit.dataset.action = 'edit';
    edit.addEventListener('click', () => openEventTemplateEditor(item));
    const restore = button('恢复默认', 'button--quiet');
    restore.setAttribute('aria-label', `恢复 ${item.label || eventLabel(item.id)}默认模板`);
    restore.dataset.recordKey = item.id;
    restore.dataset.action = 'restore';
    restore.disabled = !item.customized;
    restore.addEventListener('click', () => restoreEventTemplate(item));
    actions.append(edit, restore);
    tableRow(body, columns, [name, element('div', 'template-source', item.title || '（空标题）'), element('div', 'template-source', item.body), actions]);
  }
  view.eventTemplateBody.replaceChildren(scroll);
  if (focused?.recordKey) {
    const match = [...view.eventTemplateBody.querySelectorAll('[data-record-key]')].find((node) =>
      node.dataset.recordKey === focused.recordKey && node.dataset.action === focused.action);
    if (match && !match.disabled) match.focus({ preventScroll: true });
  }
}

function openEventTemplateEditor(item) {
  if (state.dialogBusy) return;
  const label = item.label || eventLabel(item.id);
  const edit = editor('保存此事件模板');
  edit.fields.append(element('p', 'template-guidance form-wide', `只修改「${label}」的默认格式。规则或任务选择事件默认模板时生效，不改变其他事件或共用自定义模板。`));
  const { title, body, titleField } = messageControls(edit, item.title, item.body, true);
  titleField.append(element('p', 'field-note', '标题留空时使用此事件的内置默认标题。'));
  const variables = variableControls(title, body);
  if (variables) edit.fields.append(variables);
  templatePreview(edit, title, body, item.id);
  const builtin = element('details', 'form-wide');
  builtin.append(element('summary', '', '查看内置默认格式'), facts([['标题', item.defaults.title], ['正文', item.defaults.body]], 'detail-payload'));
  edit.fields.append(builtin);
  submitEditor(edit, () => ({ title: title.value, body: body.value }),
    (payload) => request(pathFor('event-templates', item.id), { method: 'PUT', body: payload }), () => {
      dismissDialog();
      if (state.view?.name === 'templates') loadEventTemplates(state.view);
      notify(`已保存「${label}」默认模板。`);
    });
  mountDialog(`编辑默认模板 · ${label}`, edit.form);
}

function restoreEventTemplate(item) {
  const label = item.label || eventLabel(item.id);
  confirmAction(`恢复默认 · ${label}`, `只恢复「${label}」的内置标题和正文，当前自定义修改将被移除。其他事件、共用自定义模板和历史通知不会改变。`, '恢复此事件默认',
    () => request(pathFor('event-templates', item.id), { method: 'DELETE' }), () => {
      dismissDialog();
      if (state.view?.name === 'templates') loadEventTemplates(state.view);
      notify(`已恢复「${label}」默认模板。`);
    });
}

const resourceColumns = {
  devices: ['设备', '启用状态', '设备状态', '最近上报', '操作'],
  channels: ['渠道', '类型', '启用状态', '操作'],
  templates: ['模板', '标题', '正文', '操作'],
  rules: ['规则', '优先级', '匹配条件', '接收渠道', '启用状态', '操作'],
  jobs: ['任务', '类型', '执行时间', '接收渠道', '启用状态', '操作'],
};

function resourceTable(view) {
  const columns = resourceColumns[view.name];
  const { scroll, body } = table(view, columns);
  for (const item of view.items) {
    const actions = resourceActions(view.name, item);
    const identity = view.name === 'devices' ? deviceIdentity(item) : '';
    const title = item.name || identity || item.id;
    const subtitle = view.name === 'devices' && title !== identity ? identity || item.id : '';
    const name = titledCell(title, subtitle, true);
    const enabled = item.enabled ? badge('已启用', 'positive') : badge('已停用');
    const channels = `${item.channel_ids?.length ?? 0} 个渠道`;
    let cells;
    switch (view.name) {
      case 'devices':
        cells = [name, enabled, deviceStatus(item), showTime(item.last_seen, '尚未上报'), actions];
        break;
      case 'channels':
        cells = [name, channelTypeLabel(item.type), enabled, actions];
        break;
      case 'templates':
        cells = [name, element('div', 'clamp-text', item.title || '默认标题'), element('div', 'clamp-text', item.body || '—'), actions];
        break;
      case 'rules': {
        const conditions = element('div');
        conditions.append(element('div', 'clamp-text', ruleConditions(item)), element('span', 'cell-subtitle', item.template_id ? '共用自定义模板' : '按事件使用默认模板'));
        cells = [name, String(item.priority ?? '—'), conditions, channels, enabled, actions];
        break;
      }
      case 'jobs': {
        const mode = item.template_mode || (item.template_id ? 'custom' : 'inline');
        const kind = titledCell(labelFor(jobKinds, item.kind), labelFor({ event: '按事件使用默认模板', custom: '共用自定义模板', inline: '任务内格式' }, mode));
        cells = [name, kind, scheduleSummary(item.schedule), channels, enabled, actions];
        break;
      }
    }
    tableRow(body, columns, cells);
  }
  return scroll;
}

function resourceActions(resource, item) {
  const actions = element('div', 'row-actions');
  const add = (text, action, handler, danger = false) => {
    const control = button(text, danger ? 'button--quiet button--danger' : 'button--quiet');
    control.dataset.recordKey = String(item.id);
    control.dataset.action = action;
    control.setAttribute('aria-label', `${text} ${item.name || item.id}`);
    control.addEventListener('click', handler);
    actions.append(control);
  };
  add('编辑', 'edit', () => openEditor(resource, item));
  if (resource === 'devices') {
    if (item.enrollment === 'automatic') add('重绑', 'rebind', () => rebindDevice(item));
    else add('轮换令牌', 'rotate', () => rotateDevice(item));
  }
  if (resource === 'channels') add('测试发送', 'test', () => testChannel(item));
  add('删除', 'delete', () => deleteResource(resource, item), true);
  return actions;
}

function deviceIdentity(item) {
  if (item.enrollment !== 'automatic' || !item.identity_value) return '';
  if (item.identity_type === 'imei') return `IMEI ${item.identity_value}`;
  if (item.identity_type === 'sn') return `SN ${item.identity_value}`;
  return '';
}

function commandReady(connection) {
  // Both fields describe SMS command readiness; do not claim availability if they disagree.
  if (connection?.ready === false || connection?.command_ready === false) return false;
  if (connection?.ready === true || connection?.command_ready === true) return true;
  return undefined;
}

function journalSlotCount(connection, key) {
  const nested = record(connection?.journal) ? connection.journal[key] : undefined;
  return [nested, connection?.[key]].find((value) => Number.isSafeInteger(value) && value >= 0);
}

function journalSlotSummary(connection) {
  const usable = journalSlotCount(connection, 'usable_slots');
  const quarantined = journalSlotCount(connection, 'quarantined_slots');
  if (usable == null && quarantined == null) return '发送日志槽位：未上报';
  const healthy = usable == null ? '健康可用槽位数未上报' : `${usable} 个健康可用槽位`;
  const isolated = quarantined == null ? '隔离槽位数未上报' : `${quarantined} 个隔离槽位`;
  return `发送日志槽位：${healthy}，${isolated}${quarantined > 0 ? '；隔离槽位不会用于发送' : ''}。`;
}

function deviceConnectionStatus(value) {
  const connection = record(value) ? value : {};
  const content = element('div', 'device-connection');
  const labels = element('div', 'inline-actions');
  const offline = connection.state === 'offline';
  labels.append(connection.state === 'online' ? badge('连接在线', 'positive')
    : offline ? badge('连接离线', 'negative')
      : connection.state === 'unknown' ? badge('连接状态待确认', 'waiting') : badge('连接状态未上报'));
  labels.append(offline ? badge('事件通道离线', 'negative')
    : connection.event_ready === true ? badge(connection.state === 'online' ? '事件通道在线' : '事件通道已就绪', 'positive')
      : connection.event_ready === false ? badge('事件通道未就绪', 'waiting') : badge('事件就绪未上报'));
  const ready = commandReady(connection);
  labels.append(offline || ready === false ? badge('短信命令未就绪', 'waiting')
    : ready === true ? badge('短信命令就绪', 'positive') : badge('短信命令就绪未上报'));
  content.append(labels, element('p', 'field-note', journalSlotSummary(connection)));
  if (offline || ready === false) {
    content.append(element('p', 'field-note', '安全发送已禁用：设备当前不会执行短信发送命令；事件通道就绪不代表可以发送。'));
  }
  if (connection.updated_at != null && connection.updated_at !== '') {
    const updated = element('p', 'field-note');
    updated.append('连接状态更新：', showTime(connection.updated_at));
    content.append(updated);
  }
  return content;
}

function deviceStatus(item) {
  if (item.enrollment === 'automatic' && item.enrollment_pending) return badge('等待重绑', 'waiting');
  const content = deviceConnectionStatus(item.connection);
  const { status } = item;
  const reported = element('div', 'field-note');
  reported.append('最近设备状态：');
  if (!record(status)) reported.append(statusBadge(status));
  else {
    const parts = [status.operator, status.rsrp_dbm == null ? '' : `${status.rsrp_dbm} dBm`].filter(Boolean);
    reported.append(parts.join('，') || (Object.keys(status).length ? '状态已上报' : '未上报'));
  }
  content.append(reported);
  return content;
}

function ruleConditions(item) {
  const conditions = [];
  if (item.device_ids?.length) conditions.push(`${item.device_ids.length} 台设备`);
  if (item.event_types?.length) conditions.push(item.event_types.map(eventLabel).join('、'));
  if (item.sender_contains) conditions.push(`号码含「${item.sender_contains}」`);
  if (item.content_contains) conditions.push(`正文字段含「${item.content_contains}」`);
  return conditions.join('，') || '全部事件';
}

function scheduleSummary(schedule) {
  if (!schedule) return element('span', 'muted', '—');
  let time = schedule.at?.replace('T', ' ') ?? '—';
  if (schedule.mode === 'daily') time = `每天 ${schedule.time}`;
  if (schedule.mode === 'weekly') time = `${(schedule.weekdays ?? []).map((day) => weekdays[day]).join('、')} ${schedule.time}`;
  const result = element('div', 'time-text', time);
  if (schedule.time_zone) result.append(element('span', 'cell-subtitle', schedule.time_zone));
  return result;
}

function smsStatusBadge(value) {
  return badge(...(Object.hasOwn(smsStatuses, value) ? smsStatuses[value] : [value || '结果未知', 'waiting']));
}

function pendingSms(item) {
  return item?.direction === 'outgoing' && (item.send_status === 'queued' || item.send_status === 'dispatched');
}

function pendingSmsItems(view) {
  const items = new Map();
  if (pendingSms(view.selected?.item)) items.set(view.selected.key, view.selected.item);
  for (const item of view.items) {
    const key = entryKey(item, view);
    if (pendingSms(item) && !items.has(key)) items.set(key, item);
  }
  return [...items.values()];
}

function preserveSmsScroll(view, update) {
  const left = window.scrollX;
  const top = window.scrollY;
  const positions = [view.listBody.querySelector('.table-scroll'), view.detail, view.detailBody]
    .filter(Boolean).map((node) => ({ node, left: node.scrollLeft, top: node.scrollTop }));
  update();
  for (const position of positions) {
    position.node.scrollLeft = position.left;
    position.node.scrollTop = position.top;
  }
  if (window.scrollX !== left || window.scrollY !== top) window.scrollTo(left, top);
}

function stopDeviceStatusRefresh(view) {
  if (view?.name !== 'devices' || view.deviceStatusTimer == null) return;
  clearTimeout(view.deviceStatusTimer);
  view.deviceStatusTimer = null;
}

function syncDeviceStatusRefresh(view, delay = DEVICE_STATUS_REFRESH_MS) {
  if (view?.name !== 'devices') return;
  if (state.view !== view || !state.meta || state.pageHidden || document.hidden || ui.dialog.open || view.loading) {
    stopDeviceStatusRefresh(view);
    return;
  }
  if (view.deviceStatusTimer != null) return;
  view.deviceStatusTimer = setTimeout(() => {
    view.deviceStatusTimer = null;
    if (state.view === view && !view.loading && !state.pageHidden && !document.hidden && !ui.dialog.open) loadList(view);
    else syncDeviceStatusRefresh(view);
  }, Math.max(0, delay));
}

function stopSmsStatusRefresh(view, cancelReads = false) {
  if (view?.name !== 'sms') return;
  const refresh = view.smsStatusRefresh;
  if (refresh) {
    clearTimeout(refresh.timer);
    refresh.timer = null;
    refresh.controller?.abort();
  }
  if (cancelReads) {
    view.smsListRequest?.abort();
    view.smsListRequest = null;
    view.smsDetailRequest?.abort();
    view.smsDetailRequest = null;
    if (view.selected) view.selected.read = (view.selected.read ?? 0) + 1;
    if (view.detailRefresh) {
      view.detailRefresh.disabled = false;
      view.detailRefresh.textContent = '刷新状态';
      view.detail.setAttribute('aria-busy', 'false');
    }
  }
}

function syncSmsStatusRefresh(view, delay) {
  if (view?.name !== 'sms') return;
  if (state.view !== view) {
    stopSmsStatusRefresh(view);
    return;
  }
  const refresh = view.smsStatusRefresh ??= { timer: null, controller: null, failures: 0 };
  const pending = pendingSmsItems(view);
  const count = `已加载 ${view.items.length} 条${view.cursor ? '，可继续加载' : ''}`;
  const note = pending.length ? historyDialogOpen() ? '，保留与清理弹窗期间暂停状态自动更新'
    : refresh.failures ? '，状态读取暂不可用，将稍后重查' : '，待处理状态自动更新' : '';
  if (view.smsCount.textContent !== count + note) {
    preserveSmsScroll(view, () => { view.smsCount.textContent = count + note; });
  }
  if (!state.meta || state.pageHidden || document.hidden || historyDialogOpen() || !pending.length) {
    stopSmsStatusRefresh(view);
    return;
  }
  if (view.loading || view.smsDetailRequest || refresh.controller || refresh.timer != null) return;
  const wait = delay ?? Math.min(30000, SMS_STATUS_REFRESH_MS * 2 ** Math.min(refresh.failures, 3));
  refresh.timer = setTimeout(() => {
    refresh.timer = null;
    refreshSmsStatuses(view);
  }, wait);
}

function updateSmsStatus(view, item) {
  const key = entryKey(item, view);
  preserveSmsScroll(view, () => {
    view.items = view.items.map((entry) => entryKey(entry, view) === key ? item : entry);
    const status = view.smsRows.get(key)?.status;
    if (status && status.dataset.sendStatus !== item.send_status) {
      status.replaceChildren(smsStatusBadge(item.send_status));
      status.dataset.sendStatus = item.send_status;
    }
    const selected = view.selected;
    if (selected?.key === key) {
      selected.item = item;
      if (selected.summary?.isConnected && selected.summary.dataset.sendStatus !== item.send_status) {
        selected.summary.replaceChildren(smsStatusBadge(item.send_status), element('p', 'field-note', smsStateNote(item)));
        selected.summary.dataset.sendStatus = item.send_status;
      }
    }
  });
}

async function refreshSmsStatuses(view) {
  const refresh = view.smsStatusRefresh;
  if (state.view !== view || !state.meta || state.pageHidden || document.hidden || historyDialogOpen() || view.loading || view.smsDetailRequest || refresh.controller) {
    syncSmsStatusRefresh(view);
    return;
  }
  const items = pendingSmsItems(view);
  if (!items.length) {
    syncSmsStatusRefresh(view);
    return;
  }
  const controller = new AbortController();
  const session = state.session;
  const read = view.read;
  const current = () => state.view === view && session === state.session && read === view.read
    && !state.pageHidden && !document.hidden && !historyDialogOpen() && !controller.signal.aborted && refresh.controller === controller;
  refresh.controller = controller;
  let failed = false;
  try {
    // Read existing Worker records only; never poll a device or enqueue/retry an SMS.
    for (const item of items) {
      if (!current()) return;
      try {
        const result = await request(pathFor('sms', item.id), { signal: controller.signal });
        if (!current()) return;
        if (!record(result?.item) || String(result.item.id) !== String(item.id) || result.item.direction !== 'outgoing') {
          throw new Error('管理服务未返回这条短信的状态。');
        }
        const known = view.selected?.key === String(item.id) ? view.selected.item : view.items.find((entry) => String(entry.id) === String(item.id));
        if (pendingSms(known)) updateSmsStatus(view, result.item);
      } catch {
        if (!current()) return;
        failed = true;
      }
    }
  } finally {
    if (refresh.controller === controller) {
      refresh.controller = null;
      if (state.view === view && read === view.read && !controller.signal.aborted) {
        refresh.failures = failed ? refresh.failures + 1 : 0;
      }
      syncSmsStatusRefresh(view);
    }
  }
}

function numericSmsPeer(value) {
  return /^\+?[0-9]{3,20}$/.test(String(value ?? '').trim());
}

function smsQueryFilters(filters) {
  const boundary = (value, end) => {
    if (!value) return '';
    const date = new Date(`${value}T00:00:00`);
    if (end) date.setDate(date.getDate() + 1);
    return date.toISOString();
  };
  return { ...filters, limit: 30, from: boundary(filters.from, false), to: boundary(filters.to, true) };
}

function syncSmsFilters(view) {
  const widgets = view.filterWidgets;
  for (const key of ['device_id', 'q', 'status', 'from', 'to']) {
    const control = key === 'device_id' ? widgets.devices : widgets[key];
    control.value = state.smsFilters[key];
  }
  for (const [direction, control] of view.directionButtons) {
    control.setAttribute('aria-pressed', String(direction === state.smsFilters.direction));
  }
  widgets.clear.hidden = !Object.values(state.smsFilters).some(Boolean);
}

function applySmsFilters(view, direction = state.smsFilters.direction) {
  const { devices, q, status, from, to, error } = view.filterWidgets;
  showError(error);
  if (from.value && to.value && from.value > to.value) {
    showError(error, '结束日期不能早于开始日期。');
    to.focus();
    return;
  }
  state.smsFilters = { device_id: devices.value, q: q.value.trim(), direction, status: status.value, from: from.value, to: to.value };
  invalidateHistoryFilters(view);
  syncSmsFilters(view);
  if (view.selected) closeSmsDetail(view);
  view.items = [];
  view.cursor = null;
  view.pagination.hidden = true;
  view.smsFeedback.hidden = true;
  loadList(view);
}

function buildSmsWorkspace(view, surface) {
  surface.classList.add('sms-surface');
  const toolbar = element('div', 'sms-toolbar');
  const directions = element('div', 'sms-directions');
  directions.role = 'group';
  directions.setAttribute('aria-label', '短信方向');
  view.directionButtons = new Map();
  for (const { value, label } of smsDirections) {
    const control = button(label, 'button--quiet sms-tab');
    control.addEventListener('click', () => applySmsFilters(view, value));
    view.directionButtons.set(value, control);
    directions.append(control);
  }
  view.smsCount = element('p', 'field-note sms-count');
  view.smsCount.role = 'status';
  toolbar.append(directions, view.smsCount);

  const filters = element('form', 'sms-filters');
  filters.setAttribute('aria-label', '短信搜索与筛选');
  const devices = selectValue([], state.smsFilters.device_id, '全部设备');
  const q = inputValue(state.smsFilters.q, 'search');
  q.placeholder = '搜索号码或正文';
  q.maxLength = 500;
  const status = selectValue(Object.entries(smsStatuses).map(([value, [label]]) => ({ value, label })), state.smsFilters.status, '全部状态');
  const from = inputValue(state.smsFilters.from, 'date');
  const to = inputValue(state.smsFilters.to, 'date');
  const search = button('搜索', 'button--primary');
  search.type = 'submit';
  const clear = button('清除筛选', 'button--quiet');
  const error = errorRegion();
  error.classList.add('form-wide');
  const searchField = field('号码或正文', q);
  searchField.classList.add('sms-search-field');
  const statusField = field('状态', status);
  statusField.classList.add('sms-status-field');
  const actions = element('div', 'inline-actions sms-filter-actions');
  actions.append(search, clear);
  filters.append(searchField, field('设备', devices), statusField,
    field('开始日期', from, { note: '本地时间，从当日零时开始。' }),
    field('结束日期', to, { note: '包含结束日期全天。' }), actions, error);
  view.filterWidgets = { devices, q, status, from, to, clear, error };
  filters.addEventListener('submit', (event) => {
    event.preventDefault();
    applySmsFilters(view);
  });
  clear.addEventListener('click', () => {
    state.smsFilters = emptySmsFilters();
    syncSmsFilters(view);
    applySmsFilters(view, '');
    q.focus();
  });
  syncSmsFilters(view);

  view.smsRows = new Map();
  view.smsWorkspace = element('div', 'sms-workspace');
  view.smsFeedback = element('p', 'list-banner sms-feedback');
  view.smsFeedback.role = 'status';
  view.smsFeedback.hidden = true;
  view.list.prepend(view.smsFeedback);
  view.detail = element('aside', 'event-detail sms-detail');
  view.detail.id = 'sms-detail';
  view.detail.hidden = true;
  view.detail.setAttribute('aria-labelledby', 'sms-detail-title');
  view.detailHeading = element('h2', '', '短信详情');
  view.detailHeading.id = 'sms-detail-title';
  view.detailHeading.tabIndex = -1;
  const heading = element('header', 'detail-heading');
  const controls = element('div', 'inline-actions');
  view.detailRefresh = button('刷新状态', 'button--quiet');
  view.detailRefresh.addEventListener('click', () => {
    if (view.selected && !view.detailRefresh.disabled) loadSmsDetail(view, view.selected, false);
  });
  const close = button('关闭详情', 'button--quiet');
  close.addEventListener('click', () => closeSmsDetail(view, true));
  controls.append(view.detailRefresh, close);
  heading.append(view.detailHeading, controls);
  view.detailError = errorRegion();
  view.detailBody = element('div', 'detail-body');
  view.detail.append(heading, view.detailError, view.detailBody);
  view.smsWorkspace.append(view.list, view.detail);
  surface.append(toolbar, filters, view.smsWorkspace);
  loadSmsDeviceFilter(view);
}

async function loadSmsDeviceFilter(view) {
  const { devices, error } = view.filterWidgets;
  const read = allChoices('devices');
  view.filterRead = read;
  showError(error);
  try {
    const options = await read;
    if (state.view !== view || view.filterRead !== read) return;
    view.deviceCount = options.length;
    selectOptions(devices, options, devices.value || state.smsFilters.device_id, '全部设备');
  } catch (failure) {
    if (state.view === view && view.filterRead === read) showError(error, `无法加载设备筛选项，请刷新重试。${failure.message}`);
  }
}

function renderEmptySms(view) {
  const { direction, ...filters } = state.smsFilters;
  const hasFilters = Object.values(filters).some(Boolean);
  const title = hasFilters ? '没有符合筛选条件的短信' : direction === 'incoming' ? '收件箱暂无短信' : direction === 'outgoing' ? '发件箱暂无短信' : pages.sms.empty;
  const help = hasFilters ? '请调整号码、正文、状态或日期范围后重新搜索。'
    : direction === 'outgoing' ? '点击「新短信」，通过已启用设备的 SIM 发送。'
      : '设备收到短信后会显示在这里；也可点击「新短信」发送。';
  view.listBody.replaceChildren(blankState(title, help));
}

function smsTable(view) {
  const columns = ['号码与正文', '收 / 发', '设备', '发生时间', '状态', '操作'];
  const { scroll, body } = table(view, columns);
  for (const item of view.items) {
    const key = entryKey(item, view);
    const incoming = item.direction === 'incoming';
    const open = element('button', 'event-open sms-open');
    open.type = 'button';
    open.dataset.recordKey = key;
    open.dataset.action = 'open';
    open.setAttribute('aria-controls', view.detail.id);
    open.setAttribute('aria-label', `查看${incoming ? '收到' : '发出'}的短信，号码 ${item.peer || '未知'}`);
    open.append(element('span', 'cell-title sms-peer', item.peer || '未知号码'), element('span', 'cell-subtitle clamp-text sms-snippet', item.content || '（空正文）'));
    open.addEventListener('click', () => selectSms(view, item));
    const direction = element('span', `sms-direction sms-direction--${incoming ? 'incoming' : 'outgoing'}`, incoming ? '收' : '发');
    const status = element('div');
    status.dataset.sendStatus = item.send_status;
    status.append(smsStatusBadge(item.send_status));
    const actions = element('div', 'row-actions sms-row-actions');
    if (incoming) {
      const reply = button('回复', 'button--quiet');
      reply.dataset.recordKey = key;
      reply.dataset.action = 'reply';
      reply.setAttribute('aria-label', `回复 ${item.peer || '未知号码'}`);
      reply.disabled = !numericSmsPeer(item.peer);
      if (reply.disabled) {
        reply.title = '此来源不是数字号码，不能通过 SIM 回复。';
        actions.append(element('span', 'field-note', '非数字来源'));
      }
      reply.addEventListener('click', () => openSmsComposer(item));
      actions.prepend(reply);
    } else {
      const detail = button('查看', 'button--quiet');
      detail.dataset.recordKey = key;
      detail.dataset.action = 'detail';
      detail.setAttribute('aria-label', `查看发往 ${item.peer || '未知号码'} 的短信`);
      detail.addEventListener('click', () => selectSms(view, item));
      actions.append(detail);
    }
    const device = titledCell(item.device_name || item.device_id, item.device_name && item.device_name !== item.device_id ? item.device_id : '', true);
    const row = tableRow(body, columns, [open, direction, device, showTime(item.occurred_at ?? item.received_at), status, actions]);
    view.smsRows.set(key, { row, open, status });
  }
  selectSmsRow(view);
  return scroll;
}

function selectSmsRow(view) {
  for (const [key, { row, open }] of view.smsRows) {
    const selected = view.selected?.key === key;
    row.classList.toggle('is-selected', selected);
    open.setAttribute('aria-expanded', String(selected));
  }
}

function selectSms(view, item, fetchDetail = true) {
  const key = entryKey(item, view);
  item = view.items.find((entry) => entryKey(entry, view) === key) ?? item;
  view.selected = { key, item };
  view.detail.hidden = false;
  view.smsWorkspace.classList.add('with-detail');
  selectSmsRow(view);
  if (fetchDetail) loadSmsDetail(view, view.selected);
  else {
    renderSmsDetail(view, view.selected);
    syncSmsStatusRefresh(view);
  }
  view.detailHeading.focus({ preventScroll: window.matchMedia('(min-width: 71rem)').matches });
}

function closeSmsDetail(view, focus = false) {
  const key = view.selected?.key;
  view.smsDetailRequest?.abort();
  view.smsDetailRequest = null;
  view.selected = null;
  view.detail.hidden = true;
  view.detailBody.replaceChildren();
  showError(view.detailError);
  view.detailRefresh.disabled = false;
  view.detailRefresh.textContent = '刷新状态';
  view.detail.removeAttribute('aria-busy');
  view.smsWorkspace.classList.remove('with-detail');
  selectSmsRow(view);
  syncSmsStatusRefresh(view);
  if (focus) (view.smsRows.get(key)?.open ?? view.filterWidgets.q).focus();
}

async function loadSmsDetail(view, selected, showLoading = true) {
  if (state.view !== view || view.selected !== selected) return;
  if (view.loading) {
    selected.refreshAfterList = true;
    if (showLoading) renderSmsDetail(view, selected);
    return;
  }
  selected.refreshAfterList = false;
  stopSmsStatusRefresh(view);
  view.smsDetailRequest?.abort();
  const controller = new AbortController();
  view.smsDetailRequest = controller;
  const read = (selected.read ?? 0) + 1;
  selected.read = read;
  const ownsRead = () => state.view === view && view.selected === selected && selected.read === read && view.smsDetailRequest === controller;
  const current = () => ownsRead() && !controller.signal.aborted;
  view.detailRefresh.disabled = true;
  view.detailRefresh.textContent = '更新中…';
  view.detail.setAttribute('aria-busy', 'true');
  showError(view.detailError);
  if (showLoading) {
    const pending = element('p', 'muted', '正在加载短信详情…');
    pending.role = 'status';
    view.detailBody.replaceChildren(pending);
  }
  try {
    const result = await request(pathFor('sms', selected.item.id), { signal: controller.signal });
    if (!current()) return;
    if (!record(result?.item) || String(result.item.id) !== String(selected.item.id)) throw new Error('管理服务未返回这条短信的详情。');
    updateSmsStatus(view, result.item);
    preserveSmsScroll(view, () => renderSmsDetail(view, selected));
  } catch (error) {
    if (!current()) return;
    showError(view.detailError, `${error.message}可点击「刷新状态」重试。`);
    if (showLoading) view.detailBody.replaceChildren();
  } finally {
    if (ownsRead()) {
      view.smsDetailRequest = null;
      view.detailRefresh.disabled = false;
      view.detailRefresh.textContent = '刷新状态';
      view.detail.setAttribute('aria-busy', 'false');
      syncSmsStatusRefresh(view);
    }
  }
}

function smsStateNote(item) {
  if (item.direction === 'incoming') return '这是设备接收的短信。回复会使用接收设备的 SIM，发送到原号码。';
  const notes = {
    queued: '短信已登记，等待设备处理；此页可见时会自动更新状态，无需手动刷新。',
    dispatched: '命令已下发，设备正在提交短信；此页可见时会自动更新结果，请勿重复发送。',
    submitted: '设备报告短信已提交给运营商，不代表收件人已收到。',
    failed: '设备报告发送失败。请检查设备与 SIM 状态后再决定是否重新发送。',
    unknown: '尚无法确认发送结果，请勿直接重复发送；可稍后刷新状态。',
    expired: '发送请求已过期，不再等待设备执行。',
    cancelled: '发送请求已取消。',
  };
  return Object.hasOwn(notes, item.send_status) ? notes[item.send_status] : '以设备报告的结果为准；已提交不代表收件人已收到。';
}

function renderSmsDetail(view, selected) {
  const { item } = selected;
  const incoming = item.direction === 'incoming';
  const summary = element('div', 'sms-detail-summary');
  summary.dataset.sendStatus = item.send_status;
  selected.summary = summary;
  summary.append(smsStatusBadge(item.send_status), element('p', 'field-note', smsStateNote(item)));
  const content = element('p', 'sms-content', item.content || '（空正文）');
  const info = [
    ['方向', incoming ? '接收' : '发送'], ['设备', item.device_name || item.device_id],
    ['设备 ID', element('span', 'id-text', item.device_id)], [incoming ? '发件号码' : '收件号码', item.peer || '未知号码'],
    ['发生时间', showTime(item.occurred_at)], ['记录时间', showTime(item.received_at)],
  ];
  if (item.sim_slot != null) info.push(['SIM 槽位', String(item.sim_slot)]);
  if (item.sms_time) info.push(['短信原始时间', String(item.sms_time)]);
  if (!incoming && item.command_expires_at) info.push(['命令到期', showTime(item.command_expires_at)]);
  if (item.expires_at === null) info.push(['记录保留', '永久保留']);
  else if (item.expires_at != null && item.expires_at !== '') info.push(['记录保留至', showTime(item.expires_at)]);
  if (item.reply_to) info.push(['回复的短信', element('span', 'id-text', item.reply_to)]);
  if (item.event_id) info.push(['关联事件', element('span', 'id-text', item.event_id)]);
  if (item.command_id) info.push(['命令 ID', element('span', 'id-text', item.command_id)]);
  info.push(['短信 ID', element('span', 'id-text', item.id)]);
  view.detailBody.replaceChildren(summary, detailSection('正文', content), detailSection('短信信息', facts(info)));
  if (incoming) {
    const reply = button('回复短信', 'button--primary');
    reply.disabled = !numericSmsPeer(item.peer);
    reply.addEventListener('click', () => openSmsComposer(item));
    const action = element('div', 'sms-reply-action');
    const note = reply.disabled ? '此来源不是数字号码（如字母署名），不能通过 SIM 回复。'
      : `回复固定使用「${item.device_name || item.device_id}」，发送到 ${item.peer}。`;
    action.append(element('p', 'field-note', note), reply);
    view.detailBody.append(action);
  }
}

function showSmsSubmission(result) {
  dismissDialog();
  state.smsFilters = { ...emptySmsFilters(), direction: 'outgoing' };
  if (window.location.hash !== '#sms') window.location.hash = 'sms';
  openView();
  const view = state.view;
  syncSmsFilters(view);
  if (view.selected) closeSmsDetail(view);
  // Do not let an older filter request hide the newly queued message.
  view.read++;
  view.loading = false;
  view.items = [result.item];
  view.cursor = null;
  listBusy(view);
  renderList(view);
  view.smsFeedback.textContent = '发送请求已加入发件箱；此页可见时会自动更新设备处理状态，已提交不代表收件人收到。';
  view.smsFeedback.hidden = false;
  selectSms(view, result.item, false);
  notify('短信已加入发件箱，状态会自动更新。');
  loadList(view);
}

function buildEventWorkspace(view, surface) {
  const filters = element('div', 'event-filters');
  const devices = selectValue([], state.filters.device_id, '全部来源');
  const types = selectValue(eventTypes(), state.filters.type, '全部类型');
  const clear = button('清除筛选', 'button--quiet');
  const filterError = errorRegion();
  filterError.classList.add('form-wide');
  view.filterWidgets = { devices, types, error: filterError };
  const changeFilters = () => {
    state.filters = { device_id: devices.value, type: types.value };
    invalidateHistoryFilters(view);
    clear.hidden = !devices.value && !types.value;
    closeDetail(view);
    view.items = [];
    view.cursor = null;
    view.pagination.hidden = true;
    loadList(view);
  };
  clear.hidden = !state.filters.device_id && !state.filters.type;
  devices.addEventListener('change', changeFilters);
  types.addEventListener('change', changeFilters);
  clear.addEventListener('click', () => {
    devices.value = '';
    types.value = '';
    changeFilters();
    devices.focus();
  });
  filters.append(field('来源', devices), field('事件类型', types), clear, filterError);

  view.eventRows = new Map();
  view.eventWorkspace = element('div', 'event-workspace');
  view.detail = element('aside', 'event-detail');
  view.detail.id = 'event-detail';
  view.detail.hidden = true;
  view.detail.setAttribute('aria-labelledby', 'event-detail-title');
  view.detailHeading = element('h2', '', '事件详情');
  view.detailHeading.id = 'event-detail-title';
  view.detailHeading.tabIndex = -1;
  const detailHeader = element('header', 'detail-heading');
  const close = button('关闭详情', 'button--quiet');
  close.addEventListener('click', () => closeDetail(view, true));
  detailHeader.append(view.detailHeading, close);
  view.detailBody = element('div', 'detail-body');
  view.detail.append(detailHeader, view.detailBody);
  view.eventWorkspace.append(view.list, view.detail);
  surface.append(filters, view.eventWorkspace);
  loadDeviceFilter(view);
}

async function loadDeviceFilter(view) {
  const { devices, error } = view.filterWidgets;
  const read = allChoices('devices');
  view.filterRead = read;
  showError(error);
  try {
    const options = await read;
    if (state.view !== view || view.filterRead !== read) return;
    view.deviceCount = options.length;
    const sources = [...options, { value: 'scheduler', label: '计划任务' }];
    selectOptions(devices, sources, state.filters.device_id, '全部来源');
    if (!view.loading && !view.error && !view.items.length && !view.cursor) {
      renderEmptyEvents(view, state.filters.device_id || state.filters.type);
    }
  } catch (failure) {
    if (state.view === view && view.filterRead === read) showError(error, `无法加载设备筛选项。${failure.message}`);
  }
}

function eventTable(view) {
  const columns = ['事件', '来源', '接收时间', '送达状态'];
  const { scroll, body } = table(view, columns);
  for (const item of view.items) {
    const key = entryKey(item, view);
    const open = element('button', 'event-open');
    open.type = 'button';
    open.dataset.recordKey = key;
    open.dataset.action = 'open';
    open.setAttribute('aria-controls', view.detail.id);
    const title = eventLabel(item.type) || '事件';
    const summary = eventSummary(item.data);
    open.append(element('span', 'cell-title', title));
    if (summary) open.append(element('span', 'cell-subtitle clamp-text', summary));
    open.addEventListener('click', () => selectEvent(view, item));
    const status = element('div');
    status.append(statusBadge(item.delivery_status));
    const row = tableRow(body, columns, [open, item.device_name || item.device_id, showTime(item.received_at), status]);
    view.eventRows.set(key, { row, open, status });
  }
  selectEventRow(view);
  return scroll;
}

function eventSummary(data) {
  if (!record(data)) return typeof data === 'string' ? data : '';
  return [data.sender ?? data.number, data.content ?? data.text ?? data.reason]
    .filter((value) => typeof value === 'string' && value.trim()).join('　');
}

function selectEventRow(view) {
  for (const [key, { row, open }] of view.eventRows) {
    const selected = view.selected?.key === key;
    row.classList.toggle('is-selected', selected);
    open.setAttribute('aria-expanded', String(selected));
  }
}

function eventPath(item) {
  return `/events/${encodeURIComponent(item.device_id)}/${encodeURIComponent(item.event_id)}`;
}

function selectEvent(view, item) {
  const key = entryKey(item, view);
  view.selected = { key, item };
  view.detail.hidden = false;
  view.eventWorkspace.classList.add('with-detail');
  selectEventRow(view);
  loadDetail(view, view.selected);
  view.detailHeading.focus({ preventScroll: window.matchMedia('(min-width: 71rem)').matches });
}

function closeDetail(view, focus = false) {
  const key = view.selected?.key;
  view.selected = null;
  view.detail.hidden = true;
  view.detailBody.replaceChildren();
  view.eventWorkspace.classList.remove('with-detail');
  selectEventRow(view);
  if (focus) (view.eventRows.get(key)?.open ?? view.filterWidgets.devices).focus();
}

async function loadDetail(view, selected, showLoading = true) {
  const read = (selected.read ?? 0) + 1;
  selected.read = read;
  const current = () => state.view === view && view.selected === selected && selected.read === read;
  if (showLoading) {
    const pending = element('p', 'muted', '正在加载事件详情…');
    pending.role = 'status';
    view.detailBody.replaceChildren(pending);
  }
  try {
    const result = await request(eventPath(selected.item));
    if (!current()) return;
    if (!result?.item) throw new Error('管理服务未返回事件详情。');
    selected.item = result.item;
    const row = view.eventRows.get(selected.key);
    row?.status.replaceChildren(statusBadge(result.item.delivery_status));
    const summary = view.items.find((item) => entryKey(item, view) === selected.key);
    if (summary) summary.delivery_status = result.item.delivery_status;
    renderDetail(view, selected);
  } catch (error) {
    if (!current()) return;
    const message = errorRegion();
    const retry = button('重新加载详情');
    retry.addEventListener('click', () => loadDetail(view, selected));
    view.detailBody.replaceChildren(message, element('div', 'inline-actions'));
    view.detailBody.lastElementChild.append(retry);
    showError(message, error.message);
  }
}

function facts(entries, className = 'detail-facts') {
  const list = element('dl', className);
  for (const [label, value] of entries) {
    const description = element('dd');
    description.append(value);
    list.append(element('dt', '', label), description);
  }
  return list;
}

function detailSection(title, content) {
  const section = element('section', 'detail-section');
  section.append(element('h3', '', title), content);
  return section;
}

function payloadFacts(payload) {
  const stringify = (value) => typeof value === 'object' && value !== null
    ? element('pre', '', JSON.stringify(value, null, 2)) : String(value ?? '—');
  if (!record(payload)) return facts([['内容', stringify(payload)]], 'detail-payload');
  return facts(Object.entries(payload).map(([key, value]) => [labelFor(dataLabels, key), stringify(value)]), 'detail-payload');
}

function renderDetail(view, selected) {
  const { item } = selected;
  const deliveryList = element('ul', 'delivery-list');
  for (const delivery of item.deliveries ?? []) deliveryList.append(deliveryRow(view, selected, delivery));
  const basic = [
    ['事件类型', eventLabel(item.type)], ['来源', item.device_name || item.device_id],
    ['来源 ID', element('span', 'id-text', item.device_id)], ['事件 ID', element('span', 'id-text', item.event_id)],
    ['发生时间', showTime(item.occurred_at)], ['接收时间', showTime(item.received_at)],
    ['记录保留至', showTime(item.expires_at)], ['送达状态', statusBadge(item.delivery_status)],
  ];
  if (item.status && !record(item.status)) basic.push(['处理状态', statusBadge(item.status)]);
  const deliveries = detailSection('渠道送达', deliveryList.childElementCount
    ? deliveryList : element('p', 'field-note', '这条事件没有渠道送达记录。'));
  view.detailBody.replaceChildren(deliveries, detailSection('事件信息', facts(basic)));
  if (item.data != null && (!record(item.data) || Object.keys(item.data).length)) {
    view.detailBody.append(detailSection('事件数据', payloadFacts(item.data)));
  }
  if (record(item.status) && Object.keys(item.status).length) {
    view.detailBody.append(detailSection('设备状态', payloadFacts(item.status)));
  }
}

function deliveryRow(view, selected, delivery) {
  const row = element('li', 'delivery');
  const heading = element('div', 'delivery-head');
  const name = delivery.channel_name || delivery.channel_id;
  heading.append(element('h4', '', name), statusBadge(delivery.state));
  row.append(heading);
  const info = [['已尝试', `${delivery.attempts ?? 0} 次`]];
  if (delivery.updated_at) info.push(['更新时间', showTime(delivery.updated_at)]);
  if (delivery.retry_at) info.push(['下次重试', showTime(delivery.retry_at)]);
  row.append(facts(info));
  if (delivery.error) row.append(element('p', 'delivery-error', delivery.error));
  if (delivery.state === 'retry' || delivery.state === 'failed') {
    const retry = button('重试送达');
    const error = errorRegion();
    retry.setAttribute('aria-label', `重试送达 ${name}`);
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      showError(error);
      try {
        await request(`${eventPath(selected.item)}/retry`, { method: 'POST', body: { channel_id: delivery.channel_id } });
        if (state.view !== view || view.selected !== selected) return;
        notify('已安排重试，将在下一次投递检查时处理。');
        const hadFocus = row.contains(document.activeElement) || document.activeElement === document.body;
        await loadDetail(view, selected, false);
        if (hadFocus && view.selected === selected && document.activeElement === document.body) view.detailHeading.focus({ preventScroll: true });
      } catch (failure) {
        showError(error, failure.message);
      } finally {
        retry.disabled = false;
      }
    });
    row.append(retry, error);
  }
  return row;
}

function historyDialogOpen() {
  return Boolean(state.historyDialog && ui.dialog.open && ui.dialogContent.contains(state.historyDialog.content));
}

function disposeHistoryDialog() {
  const panel = state.historyDialog;
  if (!panel) return;
  state.historyDialog = null;
  panel.version++;
  clearTimeout(panel.expiryTimer);
  panel.controller?.abort();
  setDialogBusy(false);
}

function invalidateHistoryFilters(view) {
  const panel = state.historyDialog;
  if (panel?.view !== view) return;
  panel.syncDevice();
  panel.invalidate('页面筛选已更改，原预览已失效，请重新预览。');
}

function historyTimestamp(value) {
  if (value == null || value === '') return NaN;
  return new Date(typeof value === 'number' && value < 1e11 ? value * 1000 : value).getTime();
}

function historyCounts(value, keys) {
  return record(value) && keys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function validRetentionDays(days, min) {
  return Number.isInteger(days) && days >= min && days <= 90;
}

function retentionPolicy(value) {
  if (!record(value) || !validRetentionDays(value.event_days, 1)
      || (value.sms_days !== null && !validRetentionDays(value.sms_days, 0))
      || !(typeof value.revision === 'string' && value.revision.length || Number.isSafeInteger(value.revision))) {
    throw new Error('管理服务未返回有效的保留设置（天数与版本），请重新读取。');
  }
  return { ...value, sms_days: value.sms_days === null ? 0 : value.sms_days };
}

function historyBeforeIso(control) {
  const value = control.value;
  const date = new Date(value);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!parts || !Number.isFinite(date.getTime()) || date.getFullYear() !== Number(parts[1])
      || date.getMonth() + 1 !== Number(parts[2]) || date.getDate() !== Number(parts[3])
      || date.getHours() !== Number(parts[4]) || date.getMinutes() !== Number(parts[5])
      || date.getSeconds() !== Number(parts[6] || 0)) {
    invalid('请选择有效的本地日期和时间；系统时区中不存在的时刻不能使用。', control);
  }
  return date.toISOString();
}

function openRetentionDialog() {
  const view = state.view;
  // Never replace an open SMS composer or its fixed request ID.
  if (!state.meta || state.dialogBusy || ui.dialog.open || !['events', 'sms'].includes(view?.name)) return;
  disposeHistoryDialog();
  const session = state.session;
  const title = pages[view.name].title;
  const content = element('div', 'retention-editor');
  const panel = { view, content, version: 0, controller: null, expiryTimer: null, preview: null };
  state.historyDialog = panel;
  let phase = '';
  let policy = null;
  const current = () => state.historyDialog === panel && session === state.session && state.view === view
    && ui.dialog.open && ui.dialogContent.contains(content);
  const filters = () => view.name === 'events' ? state.filters : state.smsFilters;
  const deviceId = () => String(filters().device_id || '');

  const policySection = element('section', 'retention-section');
  const policyForm = element('form', 'editor-form');
  policyForm.setAttribute('aria-label', '保留设置');
  const policyFields = element('div', 'field-grid');
  const eventDays = inputValue('', 'number');
  const smsDays = inputValue('', 'number');
  for (const control of [eventDays, smsDays]) {
    control.required = true;
    control.max = '90';
    control.step = '1';
  }
  eventDays.min = '1';
  smsDays.min = '0';
  policyFields.append(field('事件保留天数', eventDays),
    field('短信保留天数', smsDays, { note: '0 = 永久保留' }));
  const policyStatus = element('p', 'field-note retention-status', '正在读取当前保留设置…');
  policyStatus.role = 'status';
  const policyError = errorRegion();
  const policyActions = element('div', 'dialog-actions');
  const reloadPolicy = button('重新读取');
  const savePolicy = button('保存设置', 'button--primary');
  savePolicy.type = 'submit';
  policyActions.append(reloadPolicy, savePolicy);
  policyForm.append(policyFields, policyStatus, policyError, policyActions);
  policySection.append(element('h3', '', '保留设置'),
    element('p', 'field-note', '默认事件保留 7 天、短信保留 30 天；事件允许 1–90 天，短信允许 0–90 天。当前值必须从服务端读取，下方不会用默认值代替读取结果。'),
    element('p', 'field-note', '保存仅更新保留策略，不会启动下方的手动清理。清理预览使用服务端已保存的策略，未保存的编辑不生效。'), policyForm);

  const cleanupSection = element('section', 'retention-section');
  const scopeForm = element('form', 'editor-form');
  scopeForm.setAttribute('aria-label', `${title}清理范围`);
  const mode = selectValue([
    { value: 'expired', label: '已到期历史' },
    { value: 'before', label: '指定时间之前' },
    { value: 'all', label: '清空全部历史（含未到期）' },
  ], 'expired');
  const before = inputValue('', 'datetime-local');
  before.step = '60';
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const beforeField = field('截止日期与时间', before, {
    note: `按当前浏览器本地时区${zone ? `（${zone}）` : '（以系统设置为准）'}解释，再转换为 ISO 时间；不使用固定时区。`,
  });
  const onlyDevice = checkbox('', Boolean(deviceId()));
  const scopeNote = element('p', 'field-note retention-scope');
  const modeWarning = element('p', 'retention-warning', '清空全部会包含范围内尚未到期的历史记录，无法撤销；服务端跳过的记录仍会保留。');
  const previewButton = button('预览清理范围');
  previewButton.type = 'submit';
  const previewActions = element('div', 'dialog-actions');
  previewActions.append(previewButton);
  scopeForm.append(field('清理模式', mode), beforeField, onlyDevice.label, scopeNote, modeWarning, previewActions);
  const cleanupError = errorRegion();
  const previewStatus = element('p', 'field-note retention-status', '先预览匹配范围，核对数量后才能确认清理。');
  previewStatus.role = 'status';
  const previewBox = element('div', 'preview-box retention-preview');
  previewBox.hidden = true;
  const confirmationSet = group('确认清理');
  confirmationSet.classList.add('retention-confirm');
  confirmationSet.hidden = true;
  const confirmation = checkbox('我已核对清理范围与数量，理解删除不可撤销，跳过的记录会保留。', false);
  const allText = inputValue();
  allText.autocomplete = 'off';
  allText.spellcheck = false;
  allText.maxLength = 4;
  const allTextField = field('请输入「清空全部」以确认', allText);
  confirmationSet.append(confirmation.label, allTextField);
  const progress = element('div', 'preview-box retention-progress');
  progress.hidden = true;
  progress.role = 'status';
  progress.setAttribute('aria-live', 'polite');
  const execute = button('确认清理', 'button--danger-solid');
  const cleanupActions = element('div', 'dialog-actions');
  cleanupActions.append(execute);
  cleanupSection.append(element('h3', '', `手动清理${title}`),
    element('p', 'retention-warning', view.name === 'events'
      ? '事件与独立短信记录分别清理：清理事件不会删除短信页的短信；如需清理短信，请到短信页另行操作。'
      : '这里只清理独立短信记录；关联的短信事件仍可能显示在事件页，如需清理事件，请到事件页另行操作。'),
    ...(view.name === 'sms' ? [element('p', 'field-note', '永久保留的短信不会出现在“已到期历史”，但仍可按指定时间或全部历史手动清理。')] : []),
    element('p', 'field-note', '在途短信等受保护记录由服务端跳过并保留，不会取消、重发或自动重试短信；不会修改设备、渠道、规则、任务配置或凭据。'),
    scopeForm, cleanupError, previewStatus, previewBox, confirmationSet, progress, cleanupActions);
  content.append(policySection, cleanupSection);

  const signature = () => JSON.stringify([filters(), mode.value, before.value, onlyDevice.node.checked]);
  const validPreview = () => panel.preview && !panel.preview.done && panel.preview.signature === signature()
    && panel.preview.expiresMs > Date.now();
  const resetConfirmation = () => {
    confirmation.node.checked = false;
    allText.value = '';
  };
  const policyLabel = (days) => days === 0 ? '永久保留' : `${days} 天`;
  const sync = () => {
    const busy = Boolean(phase);
    eventDays.disabled = smsDays.disabled = savePolicy.disabled = busy || !policy;
    reloadPolicy.disabled = busy;
    savePolicy.textContent = phase === 'save' ? '保存中…' : '保存设置';
    mode.disabled = busy;
    beforeField.hidden = mode.value !== 'before';
    before.disabled = busy || mode.value !== 'before';
    before.required = mode.value === 'before';
    onlyDevice.node.disabled = busy || !deviceId();
    modeWarning.hidden = mode.value !== 'all';
    previewButton.disabled = busy;
    previewButton.textContent = phase === 'preview' ? '正在预览…' : '预览清理范围';
    const ready = Boolean(validPreview() && panel.preview.eligible > 0);
    confirmationSet.hidden = !panel.preview || panel.preview.done;
    confirmation.node.disabled = busy || !ready;
    allTextField.hidden = mode.value !== 'all';
    allText.disabled = busy || !ready || mode.value !== 'all';
    execute.disabled = busy || !ready || !confirmation.node.checked || (mode.value === 'all' && allText.value !== '清空全部');
    execute.textContent = phase === 'cleanup' ? '正在清理…'
      : panel.preview?.batches && !panel.preview.done ? '继续清理' : mode.value === 'all' ? '确认清空全部' : '确认清理';
    content.setAttribute('aria-busy', String(busy));
  };
  const setPhase = (value) => {
    phase = value;
    if (state.historyDialog === panel) setDialogBusy(value === 'save' || value === 'cleanup');
    sync();
  };
  panel.syncDevice = () => {
    const id = deviceId();
    const selected = view.filterWidgets.devices.selectedOptions?.[0];
    const label = selected?.value === id ? selected.textContent : id;
    if (!id) onlyDevice.node.checked = false;
    onlyDevice.label.lastElementChild.textContent = id
      ? `仅当前${view.name === 'events' ? '来源' : '设备'}筛选：${label}（ID：${id}）`
      : '仅当前设备筛选（页面尚未选择设备，不能勾选）';
    scopeNote.textContent = `${onlyDevice.node.checked && id ? '仅作用于勾选的设备 / 来源。' : '将作用于所有设备 / 来源。'}${view.name === 'events'
      ? '事件类型筛选不参与清理。' : '收 / 发方向、状态、关键词和列表日期筛选均不参与清理，范围可能包含当前未显示的短信。'}`;
  };
  panel.invalidate = (message, keepSummary = false) => {
    panel.version++;
    clearTimeout(panel.expiryTimer);
    panel.preview = null;
    resetConfirmation();
    if (!keepSummary) {
      previewBox.hidden = true;
      progress.hidden = true;
    }
    showError(cleanupError);
    previewStatus.textContent = message;
    sync();
  };
  const readScope = () => {
    if (!['expired', 'before', 'all'].includes(mode.value)) invalid('请选择有效的清理模式。', mode);
    const body = { kind: view.name, mode: mode.value };
    if (mode.value === 'before') body.before = historyBeforeIso(before);
    if (onlyDevice.node.checked) {
      if (!deviceId()) invalid('当前页面没有设备筛选，请先选择设备。', onlyDevice.node);
      body.device_id = deviceId();
    }
    return body;
  };
  const showProgress = (preview, result) => {
    progress.replaceChildren(element('h3', '', '清理进度'), facts([
      ['已完成批次', `${preview.batches} 批`], ['已确认删除合计', `${preview.deleted} 条`],
      ['最近一批删除', `${result.deleted} 条`], ['最近一批跳过并保留', `${result.skipped} 条`],
      ['服务端待处理剩余', `${result.remaining} 条`], ['状态', result.done ? '本次预览范围已完成' : '尚未完成'],
    ]), element('p', 'field-note', `预览时跳过 ${preview.skipped} 条。跳过的记录不会被强制删除；各批跳过数可能重复，不累加为总数。`));
    progress.hidden = false;
  };
  const refreshHistory = () => {
    if (session !== state.session || state.view !== view) return;
    // Invalidate older list/detail reads without changing the current page filters.
    view.read++;
    if (view.name === 'sms') {
      stopSmsStatusRefresh(view, true);
      closeSmsDetail(view);
    } else closeDetail(view);
    loadList(view);
  };

  const applyPolicy = (result) => {
    policy = result;
    eventDays.value = result.event_days;
    smsDays.value = result.sms_days;
  };

  async function loadPolicy() {
    if (!current() || phase) return;
    panel.invalidate('读取设置后，请重新预览清理范围。');
    policy = null;
    eventDays.value = smsDays.value = '';
    showError(policyError);
    policyStatus.textContent = '正在读取当前保留设置…';
    const controller = panel.controller = new AbortController();
    setPhase('load');
    try {
      const result = retentionPolicy(await request('/retention', { signal: controller.signal }));
      if (!current() || controller.signal.aborted) return;
      applyPolicy(result);
      policyStatus.textContent = `服务端当前设置：事件 ${result.event_days} 天，短信 ${policyLabel(result.sms_days)}；版本 ${result.revision}。`;
    } catch (failure) {
      if (!current() || controller.signal.aborted) return;
      policyStatus.textContent = '未能读取当前设置；默认值仅供说明，不代表当前服务端设置。';
      showError(policyError, failure.message);
    } finally {
      if (current()) {
        panel.controller = null;
        setPhase('');
      }
    }
  }

  policyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!current() || phase || !policy) return;
    showError(policyError);
    let controller;
    try {
      // Number inputs report NaN, not 0, for empty or invalid values.
      const body = { event_days: eventDays.valueAsNumber, sms_days: smsDays.valueAsNumber, revision: policy.revision };
      if (!validRetentionDays(body.event_days, 1)) {
        invalid('事件保留天数必须为 1–90 的整数。', eventDays);
      }
      if (!validRetentionDays(body.sms_days, 0)) {
        invalid('短信保留天数必须为 0–90 的整数（0 = 永久保留）。', smsDays);
      }
      panel.invalidate('正在保存保留设置，旧预览已失效；保存不会自动启动手动清理。');
      controller = panel.controller = new AbortController();
      setPhase('save');
      const result = retentionPolicy(await request('/retention', { method: 'PUT', body, signal: controller.signal }));
      if (!current() || controller.signal.aborted) return;
      applyPolicy(result);
      policyStatus.textContent = `已保存：事件 ${result.event_days} 天，短信 ${policyLabel(result.sms_days)}；版本 ${result.revision}。未启动手动清理。`;
      previewStatus.textContent = '保留设置已保存，未启动手动清理；如需清理，请重新预览并确认。';
    } catch (failure) {
      if (!current() || controller?.signal.aborted) return;
      if (controller) {
        policy = null;
        policyStatus.textContent = '保存结果未确认，请重新读取当前设置后再操作。';
        previewStatus.textContent = '保存结果未确认，未启动手动清理；请重新读取设置并预览。';
      }
      showError(policyError, failure.message);
      failure.control?.focus();
    } finally {
      if (current()) {
        panel.controller = null;
        setPhase('');
      }
    }
  });
  reloadPolicy.addEventListener('click', loadPolicy);
  for (const control of [eventDays, smsDays]) {
    control.addEventListener('input', () => panel.invalidate('保留设置有未保存的编辑；预览仍使用服务端已保存的策略，请重新预览。'));
  }
  for (const [control, eventName] of [[mode, 'change'], [before, 'input'], [onlyDevice.node, 'change']]) {
    control.addEventListener(eventName, () => {
      panel.syncDevice();
      panel.invalidate('清理模式或范围已更改，请重新预览。');
    });
  }
  confirmation.node.addEventListener('change', sync);
  allText.addEventListener('input', sync);

  scopeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!current() || phase) return;
    panel.invalidate('正在获取清理预览，不会删除记录…');
    const version = panel.version;
    let controller;
    try {
      const body = readScope();
      const scopeSignature = signature();
      controller = panel.controller = new AbortController();
      setPhase('preview');
      const result = await request('/history/preview', { method: 'POST', body, signal: controller.signal });
      if (!current() || controller.signal.aborted || version !== panel.version || scopeSignature !== signature()) return;
      const expiresMs = historyTimestamp(result?.expires_at);
      if (!historyCounts(result, ['matched', 'eligible', 'skipped']) || typeof result.preview_token !== 'string' || !result.preview_token
          || !Number.isFinite(expiresMs) || (body.mode !== 'all' && !Number.isFinite(historyTimestamp(result.cutoff)))) {
        throw new Error('管理服务未返回完整有效的清理预览（令牌、数量、截止时间与有效期），无法确认清理。');
      }
      const preview = panel.preview = { ...result, body, signature: scopeSignature, expiresMs, token: result.preview_token,
        done: false, batches: 0, deleted: 0 };
      const scope = body.device_id ? `仅设备 / 来源 ${body.device_id}` : '所有设备 / 来源';
      previewBox.replaceChildren(element('h3', '', `${title}清理预览`),
        element('p', 'retention-scope', `范围：${scope}；模式：${mode.selectedOptions[0].textContent}。`),
        facts([['匹配记录', `${result.matched} 条`], ['可清理记录', `${result.eligible} 条`],
          ['跳过并保留', `${result.skipped} 条`],
          ['清理截止', body.mode === 'all' && result.cutoff == null ? '不限时间（含未到期）' : showTime(result.cutoff)],
          ['预览有效至', showTime(result.expires_at)]]));
      if (body.before) previewBox.append(element('p', 'field-note id-text', `指定截止时间（ISO / UTC）：${body.before}`));
      previewBox.hidden = false;
      previewStatus.textContent = expiresMs <= Date.now() ? '服务端返回的预览已过期，请重新预览后再确认清理。'
        : result.eligible ? '请核对以上范围与数量，再显式确认。每次点击最多串行处理 20 批，未完成时可再次确认后继续。'
          : '当前没有可清理记录；跳过的记录会保留。';
      panel.expiryTimer = setTimeout(() => {
        if (!current() || panel.preview !== preview || preview.done || preview.expiresMs > Date.now()) return;
        resetConfirmation();
        previewStatus.textContent = '预览已过期，请重新预览后再确认清理。';
        sync();
      }, Math.min(Math.max(0, expiresMs - Date.now()), 2147483647));
    } catch (failure) {
      if (!current() || controller?.signal.aborted || version !== panel.version) return;
      previewStatus.textContent = '预览未完成，没有删除任何记录。';
      showError(cleanupError, failure.message);
      failure.control?.focus();
    } finally {
      if (current()) {
        panel.controller = null;
        setPhase('');
      }
    }
  });

  execute.addEventListener('click', async () => {
    if (!current() || phase) return;
    const preview = panel.preview;
    if (!validPreview() || !preview.eligible) {
      panel.invalidate('预览已失效或没有可清理记录，请重新预览。');
      return;
    }
    if (!confirmation.node.checked || (preview.body.mode === 'all' && allText.value !== '清空全部')) {
      showError(cleanupError, preview.body.mode === 'all' ? '请勾选确认并准确输入「清空全部」。' : '请先勾选清理确认。');
      return;
    }
    showError(cleanupError);
    const version = panel.version;
    const controller = panel.controller = new AbortController();
    const ownsPreview = () => current() && !controller.signal.aborted && version === panel.version
      && panel.preview === preview && preview.signature === signature();
    let attempted = false;
    setPhase('cleanup');
    try {
      for (let batch = 0; batch < HISTORY_CLEANUP_BATCH_LIMIT; batch++) {
        if (!ownsPreview() || preview.done || preview.expiresMs <= Date.now()) break;
        if (document.hidden || state.pageHidden) {
          previewStatus.textContent = '页面不可见，已停止继续分批；返回后请核对进度并再次确认。';
          break;
        }
        attempted = true;
        const result = await request('/history/cleanup', { method: 'POST', signal: controller.signal,
          body: { preview_token: preview.token, confirm: preview.body.mode === 'all' ? '清空全部' : '清理' } });
        if (!ownsPreview()) return;
        if (!historyCounts(result, ['deleted', 'skipped', 'remaining']) || typeof result.done !== 'boolean'
            || (result.preview_token != null && (typeof result.preview_token !== 'string' || !result.preview_token))) {
          throw new Error('管理服务未返回完整有效的清理结果，结果尚未确认；请重新预览，不会自动重试。');
        }
        preview.batches++;
        preview.deleted += result.deleted;
        preview.done = result.done;
        if (result.preview_token) preview.token = result.preview_token;
        showProgress(preview, result);
        previewStatus.textContent = result.done ? '本次预览范围已处理完成；跳过的记录仍会保留。'
          : `清理进行中：已确认删除 ${preview.deleted} 条，服务端待处理剩余 ${result.remaining} 条；跳过记录保留。`;
        if (result.done) {
          clearTimeout(panel.expiryTimer);
          break;
        }
        if (batch === HISTORY_CLEANUP_BATCH_LIMIT - 1) {
          previewStatus.textContent = '已达到本次点击的 20 批上限，尚未完成；请核对进度，再次勾选确认后点击「继续清理」。';
        }
      }
      if (ownsPreview() && !preview.done && preview.expiresMs <= Date.now()) {
        previewStatus.textContent = '预览已过期，已停止继续分批；请重新预览，已确认的清理进度保留如下。';
      }
    } catch (failure) {
      if (!ownsPreview()) return;
      panel.invalidate('已停止清理，不会自动重试。已确认的进度保留如下；请重新预览后再决定。', true);
      showError(cleanupError, failure.message);
    } finally {
      if (current()) {
        panel.controller = null;
        resetConfirmation();
        setPhase('');
        if (attempted) refreshHistory();
      }
    }
  });

  panel.syncDevice();
  sync();
  mountDialog(`${title} · 保留与清理`, content, ui.dialogTitle);
  stopSmsStatusRefresh(view);
  syncSmsStatusRefresh(view);
  loadPolicy();
}

function setDialogBusy(busy) {
  state.dialogBusy = busy;
  ui.dialogClose.disabled = busy;
}

function mountDialog(title, content, focus) {
  if (state.historyDialog && state.historyDialog.content !== content) disposeHistoryDialog();
  const reopening = ui.dialog.open;
  if (!reopening) state.dialogOpener = document.activeElement;
  ui.dialogTitle.textContent = title;
  ui.dialogContent.replaceChildren(content);
  ui.dialogContent.scrollTop = 0;
  if (!reopening) ui.dialog.showModal();
  const target = focus || content.querySelector('input:not([type="checkbox"], [readonly]), select, textarea') || ui.dialogTitle;
  target.focus({ preventScroll: true });
}

function dismissDialog() {
  if (!state.dialogBusy) ui.dialog.close();
}

function editor(saveText = '保存', danger = false) {
  const form = element('form', 'editor-form');
  const fields = element('div', 'field-grid');
  const error = errorRegion();
  const actions = element('div', 'dialog-actions');
  const cancel = button('取消');
  cancel.addEventListener('click', dismissDialog);
  const save = button(saveText, danger ? 'button--danger-solid' : 'button--primary');
  save.type = 'submit';
  actions.append(cancel, save);
  form.append(fields, error, actions);
  return { form, fields, error, actions, cancel, save };
}

function invalid(message, control) {
  throw Object.assign(new Error(message), { control });
}

function submitEditor(edit, read, send, onSuccess) {
  edit.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.dialogBusy) return;
    showError(edit.error);
    let result;
    const saveText = edit.save.textContent;
    const current = () => ui.dialog.open && ui.dialogContent.contains(edit.form);
    try {
      const payload = read();
      setDialogBusy(true);
      edit.cancel.disabled = true;
      edit.save.disabled = true;
      edit.save.textContent = '处理中…';
      result = await send(payload);
    } catch (error) {
      if (!current()) return;
      showError(edit.error, error.message);
      error.control?.focus();
      return;
    } finally {
      if (current()) {
        edit.cancel.disabled = false;
        edit.save.disabled = false;
        edit.save.textContent = saveText;
        setDialogBusy(false);
      }
    }
    if (current()) onSuccess(result);
  });
}

function standardFields(edit, item, withEnabled = true) {
  const name = inputValue(item?.name);
  name.required = true;
  name.maxLength = 128;
  edit.fields.append(field('名称', name, { wide: true }));
  const enabled = checkbox('启用', item?.enabled ?? true);
  if (withEnabled) {
    enabled.label.classList.add('form-wide');
    edit.fields.append(enabled.label);
  }
  return () => {
    if (!name.value.trim()) invalid('请填写名称。', name);
    const values = { name: name.value.trim() };
    if (withEnabled) values.enabled = enabled.node.checked;
    return values;
  };
}

function refreshResource(resource) {
  state.choices.delete(resource);
  if (state.view?.name === resource) loadList(state.view);
  if (resource === 'devices' && state.view?.name === 'events') loadDeviceFilter(state.view);
  if (resource === 'devices' && state.view?.name === 'sms') loadSmsDeviceFilter(state.view);
}

async function openEditor(resource, item) {
  const title = item ? `编辑${resourceNames[resource]}` : pages[resource].create;
  let references = [];
  if (resource === 'rules' || resource === 'jobs') {
    const loading = element('p', 'muted', '正在加载可选设备、模板和渠道…');
    loading.role = 'status';
    mountDialog(title, loading);
    try {
      references = await Promise.all(['devices', 'templates', 'channels'].map(allChoices));
    } catch (error) {
      if (ui.dialogContent.contains(loading) && ui.dialog.open) {
        const message = errorRegion();
        loading.replaceWith(message);
        showError(message, error.message);
      }
      return;
    }
    if (!ui.dialog.open || !ui.dialogContent.contains(loading)) return;
  }
  const edit = editor(item ? '保存' : pages[resource].create);
  const builders = { devices: deviceFields, channels: channelFields, templates: templateFields, rules: ruleFields, jobs: jobFields };
  const read = builders[resource](edit, item, references);
  submitEditor(edit, read, (body) => request(pathFor(resource, item?.id), { method: item ? 'PUT' : 'POST', body }), (result) => {
    refreshResource(resource);
    if (resource === 'devices' && !item) {
      showToken(result, '设备已注册');
    } else {
      dismissDialog();
      notify(item ? '已保存。' : `已${pages[resource].create}。`);
    }
  });
  mountDialog(title, edit.form);
}

function deviceFields(edit, item) {
  const id = inputValue(item?.id);
  id.required = !item;
  id.readOnly = Boolean(item);
  id.maxLength = 80;
  id.autocomplete = 'off';
  id.autocapitalize = 'off';
  id.spellcheck = false;
  const format = '以字母或数字开头，可使用字母、数字、点、短横线或下划线。';
  edit.fields.append(field('设备 ID', id, { note: item ? null : format, wide: true }));
  const standard = standardFields(edit, item);
  if (item) {
    const latest = element('details', 'form-wide');
    latest.append(element('summary', '', '实时连接与安全发送'), deviceConnectionStatus(item.connection));
    const session = item.connection?.session_id || item.connection?.id;
    if (typeof session === 'string' && session) latest.append(facts([['连接会话', element('span', 'id-text', session)]]));
    edit.fields.append(latest);
  }
  if (record(item?.status) && Object.keys(item.status).length) {
    const latest = element('details', 'form-wide');
    latest.append(element('summary', '', '最近上报的设备状态'), payloadFacts(item.status));
    edit.fields.append(latest);
  }
  return () => {
    const values = standard();
    if (item) return values;
    const deviceId = id.value.trim();
    if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(deviceId)) invalid(`设备 ID 格式无效。${format}`, id);
    return { id: deviceId, ...values };
  };
}

function settingsOptions(options) {
  if (Array.isArray(options)) {
    return options.map((option) => {
      if (!record(option)) return { value: option, label: String(option) };
      const value = option.value ?? option.id ?? option.key;
      return { value, label: option.label ?? String(value) };
    });
  }
  return Object.entries(options ?? {}).map(([value, label]) => ({ value, label: label?.label ?? label }));
}

function channelControl(definition, value) {
  switch (definition.kind) {
    case 'select':
      return selectValue(settingsOptions(definition.options), value, '请选择');
    case 'textarea':
      return textarea(value);
    case 'json':
      return textarea(value == null ? '' : JSON.stringify(value, null, 2));
    case 'number': {
      const input = inputValue(value, 'number');
      input.step = 'any';
      return input;
    }
    case 'password':
    case 'url':
      return inputValue(value, definition.kind);
    default:
      return inputValue(value, definition.secret ? 'password' : 'text');
  }
}

function channelFields(edit, item) {
  const standard = standardFields(edit, item);
  const definitions = channelTypes();
  const types = Object.entries(definitions).map(([value, definition]) => ({ value, label: definition.label || value }));
  const type = selectValue(types, item?.type, '选择渠道类型');
  type.required = true;
  const configBox = group('渠道配置');
  const configFields = element('div', 'field-grid');
  configBox.append(configFields);
  edit.fields.append(field('类型', type, { wide: true }), configBox);
  const savedSecrets = new Set(item?.secret_fields ?? []);
  let fields = [];
  function drawConfig() {
    const definition = Object.hasOwn(definitions, type.value) ? definitions[type.value] : null;
    const sameType = item?.type === type.value;
    configFields.replaceChildren();
    fields = (definition?.fields ?? []).map((def) => {
      const saved = sameType && savedSecrets.has(def.key);
      const secret = Boolean(def.secret || def.kind === 'password' || saved);
      const input = channelControl(def, sameType && !secret ? item.config?.[def.key] : undefined);
      input.required = Boolean(def.required && !saved);
      if (def.placeholder != null && 'placeholder' in input) input.placeholder = def.placeholder;
      if (secret) input.autocomplete = 'new-password';
      configFields.append(field(def.label || def.key, input, {
        note: saved ? '已保存，留空保留。' : null, wide: input.tagName === 'TEXTAREA',
      }));
      return { def, input, secret };
    });
    configBox.hidden = fields.length === 0;
  }
  type.addEventListener('change', drawConfig);
  drawConfig();
  return () => {
    if (!Object.hasOwn(definitions, type.value)) invalid('请选择有效的渠道类型。', type);
    const config = Object.create(null);
    for (const { def, input, secret } of fields) {
      const value = input.value;
      if (!value && (secret || def.kind === 'number' || def.kind === 'json')) continue;
      if (def.kind === 'number') {
        config[def.key] = Number(value);
      } else if (def.kind === 'json') {
        try {
          config[def.key] = JSON.parse(value);
        } catch {
          invalid(`${def.label || def.key}须为有效的 JSON。`, input);
        }
      } else if (def.kind === 'select') {
        config[def.key] = settingsOptions(def.options).find((option) => String(option.value) === value)?.value ?? value;
      } else {
        config[def.key] = value;
      }
    }
    return { ...standard(), type: type.value, config };
  };
}

function messageControls(edit, titleValue, bodyValue, required = false) {
  const title = inputValue(titleValue);
  title.maxLength = 256;
  const body = textarea(bodyValue, 5);
  body.maxLength = 8192;
  body.required = required;
  const titleField = field('标题', title, { wide: true });
  const bodyField = field('正文', body, { wide: true });
  edit.fields.append(titleField, bodyField);
  return { title, body, titleField, bodyField };
}

function variableControls(title, body) {
  const variables = (state.meta?.template_variables ?? []).map(({ name, label }) => {
    const value = name.startsWith('{{') ? name : `{{${name}}}`;
    return { value, label: label ? `${label}　${value}` : value };
  });
  if (!variables.length) return null;
  const set = group('插入变量');
  const bar = element('div', 'snippet-controls');
  const variable = selectValue(variables);
  const toTitle = button('插入标题');
  const toBody = button('插入正文');
  const insert = (input) => {
    input.setRangeText(variable.value, input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  toTitle.addEventListener('click', () => insert(title));
  toBody.addEventListener('click', () => insert(body));
  bar.append(field('变量', variable), toTitle, toBody);
  set.append(bar);
  return set;
}

function templateFields(edit, item) {
  const standard = standardFields(edit, item, false);
  edit.fields.append(element('p', 'template-guidance form-wide', '这是共用自定义模板，修改会影响所有引用它的规则或任务。若只想修改收到短信等某一事件，请编辑模板页上方对应的事件默认模板。'));
  const { title, body } = messageControls(edit, item?.title, item?.body, true);
  const variables = variableControls(title, body);
  if (variables) edit.fields.append(variables);
  templatePreview(edit, title, body);
  return () => ({ ...standard(), title: title.value, body: body.value });
}

function templatePreview(edit, title, body, eventType) {
  const set = group('模板预览', eventType ? '仅预览当前事件的格式。' : '样本事件只影响预览，不会限制这条共用模板适用的事件。');
  const bar = element('div', 'snippet-controls');
  const samples = eventTypes();
  const defaultType = samples.find(({ value }) => value === (eventType || 'sms.received')) ?? samples[0];
  const type = selectValue(samples, defaultType?.value);
  type.disabled = Boolean(eventType);
  const render = button('生成预览');
  render.disabled = !defaultType;
  const result = element('div', 'preview-box form-wide');
  result.hidden = true;
  result.setAttribute('aria-live', 'polite');
  const error = errorRegion();
  error.classList.add('form-wide');
  let editVersion = 0;
  const resetPreview = () => {
    editVersion++;
    result.hidden = true;
    showError(error);
  };
  title.addEventListener('input', resetPreview);
  body.addEventListener('input', resetPreview);
  type.addEventListener('change', resetPreview);
  render.addEventListener('click', async () => {
    const version = editVersion;
    render.disabled = true;
    result.hidden = true;
    showError(error);
    try {
      const preview = await request('/templates/preview', {
        method: 'POST', body: { title: title.value, body: body.value, type: type.value },
      });
      if (version !== editVersion || !result.isConnected) return;
      result.replaceChildren(element('h3', '', '预览结果'), facts([['标题', preview.title ?? ''], ['正文', preview.body ?? '']], 'detail-payload'));
      result.hidden = false;
    } catch (failure) {
      if (version === editVersion && result.isConnected) showError(error, failure.message);
    } finally {
      render.disabled = false;
    }
  });
  bar.append(field(eventType ? '对应事件' : '样本事件', type), render);
  set.append(bar);
  edit.fields.append(set, error, result);
}

function routeControls(edit, item, templates, channels, { job = false } = {}) {
  const mode = job ? selectValue([
    { value: 'event', label: '按事件使用默认模板' }, { value: 'custom', label: '共用自定义模板' }, { value: 'inline', label: '任务内格式' },
  ], item ? item.template_mode || (item.template_id ? 'custom' : 'inline') : 'event') : null;
  if (mode) edit.fields.append(field('模板模式', mode, { wide: true }));
  const template = selectValue(templates, item?.template_id, job ? '选择自定义模板' : '按事件使用默认模板');
  const templateField = field(job ? '共用自定义模板' : '模板', template, { wide: true });
  const note = element('p', 'template-guidance form-wide');
  const sync = () => {
    const shared = job ? mode.value === 'custom' : Boolean(template.value);
    if (job) {
      templateField.hidden = !shared;
      template.disabled = !shared;
      template.required = shared;
    }
    note.textContent = shared ? job
      ? '使用选中的共用格式，不跟随事件默认模板。短信专用变量在计划任务中为空，请使用 {{JOB_NAME}}、{{CONTENT}} 等计划任务变量。'
      : '所有匹配事件都会使用选中的共用格式。短信专用变量在其他事件中会为空；若规则匹配多种事件，建议改用「按事件使用默认模板」，或将规则范围限制为「收到短信」。'
      : mode?.value === 'inline' ? '仅此任务使用下方填写的格式，不跟随事件默认模板。已有任务保留此模式。'
        : '按实际事件类型使用「模板」页对应的默认格式；各事件可以分别修改、预览和恢复默认。';
  };
  template.addEventListener('change', sync);
  mode?.addEventListener('change', sync);
  sync();
  const targets = multiChoice('接收渠道', channels, item?.channel_ids, { empty: '请先在「渠道」中添加接收渠道。' });
  edit.fields.append(templateField, note, targets.set);
  return {
    template, mode,
    channelIds() {
      if (mode?.value === 'custom' && !template.value) invalid('请选择自定义模板。', template);
      const ids = targets.values();
      if (!ids.length) invalid('请至少选择一个接收渠道。', targets.set.querySelector('input'));
      return ids;
    },
  };
}

function ruleFields(edit, item, [devices, templates, channels]) {
  const standard = standardFields(edit, item);
  const priority = inputValue(item?.priority ?? 100, 'number');
  priority.required = true;
  priority.step = '1';
  priority.min = '-10000';
  priority.max = '10000';
  edit.fields.append(field('优先级', priority, { note: '数值越小越先匹配。', wide: true }));
  const conditions = group('匹配条件', '留空的条件匹配全部。');
  const grid = element('div', 'field-grid');
  const selectedDevices = multiChoice('设备', devices, item?.device_ids, { empty: '暂无已注册设备。' });
  const deviceTypes = eventTypes().filter(({ value }) => !value.startsWith('schedule.'));
  const selectedEvents = multiChoice('事件类型', deviceTypes, item?.event_types);
  const sender = inputValue(item?.sender_contains);
  sender.maxLength = 80;
  const content = inputValue(item?.content_contains);
  content.maxLength = 256;
  grid.append(selectedDevices.set, selectedEvents.set, field('号码包含', sender), field('内容包含', content));
  conditions.append(grid);
  edit.fields.append(conditions);
  const { template, channelIds } = routeControls(edit, item, templates, channels);
  return () => ({
    ...standard(), priority: Number(priority.value), device_ids: selectedDevices.values(), event_types: selectedEvents.values(),
    sender_contains: sender.value, content_contains: content.value, template_id: template.value, channel_ids: channelIds(),
  });
}

function scheduleFields(edit, schedule = {}) {
  const timing = group('执行时间');
  const grid = element('div', 'field-grid');
  const mode = selectValue([
    { value: 'once', label: '单次' }, { value: 'daily', label: '每日' }, { value: 'weekly', label: '每周' },
  ], schedule.mode || 'once');
  const zone = inputValue(schedule.time_zone || 'Asia/Shanghai');
  zone.required = true;
  zone.maxLength = 64;
  const datetime = inputValue(schedule.at, 'datetime-local');
  const time = inputValue(schedule.time, 'time');
  const atField = field('日期和时间', datetime, { wide: true });
  const timeField = field('执行时刻', time, { wide: true });
  const days = multiChoice('执行日期', weekdays.map((label, value) => ({ value, label })), schedule.weekdays);
  grid.append(field('重复方式', mode), field('时区', zone, { note: '例如 Asia/Shanghai' }), atField, timeField, days.set);
  timing.append(grid);
  edit.fields.append(timing);
  const syncMode = () => {
    const once = mode.value === 'once';
    atField.hidden = !once;
    datetime.disabled = !once;
    datetime.required = once;
    timeField.hidden = once;
    time.disabled = once;
    time.required = !once;
    days.set.hidden = mode.value !== 'weekly';
  };
  mode.addEventListener('change', syncMode);
  syncMode();
  return () => {
    const time_zone = zone.value.trim();
    if (!time_zone) invalid('请填写时区。', zone);
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: time_zone });
    } catch {
      invalid('请输入有效的时区，例如 Asia/Shanghai。', zone);
    }
    if (mode.value === 'once') return { mode: 'once', time_zone, at: datetime.value };
    const repeat = { mode: mode.value, time_zone, time: time.value };
    if (mode.value === 'weekly') {
      repeat.weekdays = days.values();
      if (!repeat.weekdays.length) invalid('每周任务至少选择一天。', days.set.querySelector('input'));
    }
    return repeat;
  };
}

function jobFields(edit, item, [devices, templates, channels]) {
  const standard = standardFields(edit, item);
  const kind = selectValue(Object.entries(jobKinds).map(([value, label]) => ({ value, label })), item?.kind || 'message');
  edit.fields.append(field('任务类型', kind, { wide: true }));
  const schedule = scheduleFields(edit, item?.schedule);
  const selectedDevices = multiChoice('设备', devices, item?.device_ids, { note: '留空时使用所有已启用设备。', empty: '暂无已注册设备。' });
  const minutes = inputValue(item?.offline_minutes ?? 780, 'number');
  minutes.min = '1';
  minutes.max = '43200';
  minutes.step = '1';
  const threshold = field('离线阈值（分钟）', minutes, { wide: true });
  edit.fields.append(selectedDevices.set, threshold);
  const { template, mode, channelIds } = routeControls(edit, item, templates, channels, { job: true });
  const { title, body, titleField, bodyField } = messageControls(edit, item?.title, item?.body);
  const contentNote = element('p', 'field-note', '事件默认模板中的 {{CONTENT}} 会插入这里的内容；其中的时间、任务名称等变量会先解析。');
  bodyField.append(contentNote);
  const variables = variableControls(title, body);
  if (variables) edit.fields.append(variables);
  function syncKind() {
    const message = kind.value === 'message';
    const offline = kind.value === 'offline';
    const shared = mode.value === 'custom';
    const inline = mode.value === 'inline';
    selectedDevices.set.hidden = message;
    threshold.hidden = !offline;
    minutes.disabled = !offline;
    minutes.required = offline;
    titleField.hidden = !inline;
    bodyField.hidden = !message || shared;
    bodyField.querySelector('label').textContent = inline ? '正文格式' : '推送内容';
    contentNote.hidden = mode.value !== 'event';
    body.required = message && !shared;
    if (variables) {
      variables.hidden = shared || (!message && !inline);
      const buttons = variables.querySelectorAll('button');
      buttons[0].hidden = !inline;
      buttons[1].hidden = !message;
    }
  }
  kind.addEventListener('change', syncKind);
  mode.addEventListener('change', syncKind);
  syncKind();
  return () => ({
    ...standard(), kind: kind.value, schedule: schedule(), device_ids: kind.value === 'message' ? [] : selectedDevices.values(),
    offline_minutes: kind.value === 'offline' ? Number(minutes.value) : item?.offline_minutes,
    template_mode: mode.value, template_id: mode.value === 'custom' ? template.value : '',
    channel_ids: channelIds(), title: title.value, body: body.value,
  });
}

function estimateSms(content) {
  const characters = Array.from(content).length;
  const unsupported = /[\uD800-\uDFFF]/.test(content);
  const basic = '@$\n\r_ !"#%&\'()*+,-./0123456789:;<=>?ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const extended = '^{}\\[~]|\f';
  let units = 0;
  let gsm = true;
  for (const character of content) {
    if (basic.includes(character)) units++;
    else if (extended.includes(character)) units += 2;
    else { gsm = false; break; }
  }
  if (!gsm) units = content.length;
  const single = gsm ? 160 : 70;
  const multiple = gsm ? 153 : 67;
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multiple);
  return { characters, unsupported, segments, gsm };
}

async function openSmsComposer(replyTo = null) {
  if (!state.meta || state.dialogBusy) return;
  const title = replyTo ? '回复短信' : '新短信';
  const loading = element('p', 'muted', '正在加载已启用设备…');
  loading.role = 'status';
  mountDialog(title, loading);
  const session = state.session;
  const current = () => session === state.session && ui.dialog.open && ui.dialogContent.contains(loading);
  try {
    const [options, original] = await Promise.all([
      allChoices('devices'), replyTo ? request(pathFor('sms', replyTo.id)) : Promise.resolve(null),
    ]);
    if (!current()) return;
    const enabled = options.filter((option) => option.enabled);
    const source = replyTo ? original?.item : null;
    if (replyTo && (!record(source) || String(source.id) !== String(replyTo.id) || source.direction !== 'incoming')) {
      throw new Error('管理服务未返回可回复的原短信，请重新加载详情。');
    }
    if (source && !numericSmsPeer(source.peer)) throw new Error('原短信来源不是数字号码，不能通过 SIM 回复。');
    if (source && !enabled.some((option) => String(option.value) === String(source.device_id))) {
      throw new Error('原设备已停用或不可用，不能回复。请先在设备页确认启用状态。');
    }
    if (!enabled.length) throw new Error('暂无已启用设备，请先在设备页启用设备。');
    if (!globalThis.crypto?.randomUUID) throw new Error('当前浏览器无法生成请求 ID，请使用支持安全连接的现代浏览器。');
    buildSmsComposer(enabled, source, crypto.randomUUID());
  } catch (failure) {
    if (!current()) return;
    const content = element('div', 'editor-form');
    const error = errorRegion();
    showError(error, failure.message);
    const actions = element('div', 'inline-actions');
    const retry = button('重新加载');
    retry.addEventListener('click', () => openSmsComposer(replyTo));
    const devices = element('a', 'button button--quiet', '前往设备');
    devices.href = '#devices';
    devices.addEventListener('click', dismissDialog);
    actions.append(retry, devices);
    content.append(error, actions);
    mountDialog(title, content, ui.dialogTitle);
  }
}

function buildSmsComposer(devices, source, requestId) {
  const edit = editor('确认发送');
  edit.form.classList.add('sms-editor');
  let device;
  let to;
  if (source) {
    const original = devices.find((option) => String(option.value) === String(source.device_id));
    const target = facts([
      ['原设备', original.label], ['设备 ID', element('span', 'id-text', source.device_id)],
      ['原号码', element('span', 'sms-peer', source.peer)],
    ]);
    target.classList.add('form-wide', 'sms-reply-target');
    edit.fields.append(target, element('p', 'field-note form-wide', '回复固定使用原设备和原号码，由服务器确定，不能改为其他设备或号码。'));
  } else {
    device = selectValue(devices, '', '选择已启用设备');
    device.required = true;
    to = inputValue('', 'tel');
    to.required = true;
    to.maxLength = 21;
    to.pattern = '\\+?[0-9]{1,20}';
    to.inputMode = 'tel';
    to.autocomplete = 'off';
    edit.fields.append(field('发送设备', device, { note: '仅列出已启用设备。离线时会等待设备处理，发送请求可能到期。', wide: true }),
      field('收件号码', to, { note: '仅数字号码，可用 + 开头（如 +8613800000000）。', wide: true }));
  }
  const content = textarea('', 6);
  content.required = true;
  content.maxLength = 500;
  const bodyField = field('短信正文', content, { note: '最多 500 个 BMP 字符，不支持非 BMP 字符（如部分表情）。', wide: true });
  const count = element('p', 'field-note sms-character-count');
  count.id = `${content.id}-count`;
  count.role = 'status';
  content.setAttribute('aria-describedby', `${content.getAttribute('aria-describedby')} ${count.id}`);
  bodyField.append(count, element('p', 'field-note', '分段仅为估算：汉字及混合正文为单段 70、长短信每段 67 字符；GSM 英文为 160 / 153 单位，扩展符号可能占两单位。实际分段与费用以设备和运营商为准。'));
  const charge = element('p', 'sms-charge-note form-wide', '发送会使用设备的 SIM，产生的短信资费由运营商按套餐计费；长短信可能按多段计费。发送状态“已提交”不代表收件人已收到。');
  const confirmation = checkbox('我已确认设备、号码、正文与短信资费。', false);
  confirmation.node.required = true;
  confirmation.label.classList.add('form-wide', 'sms-charge-confirm');
  const retryNote = element('p', 'field-note form-wide sms-request-note');
  retryNote.hidden = true;
  edit.fields.append(bodyField, charge, confirmation.label, retryNote);
  let fixedBody = null;
  let attempted = false;
  const controls = [device, to, content, confirmation.node].filter(Boolean);
  const sync = () => {
    const estimate = estimateSms(content.value);
    const invalidContent = estimate.unsupported || content.value.length > 500;
    const message = estimate.unsupported ? '正文含非 BMP 字符（如部分表情），请删除后再发送。'
      : content.value.length > 500 ? '正文不能超过 500 个 BMP 字符。' : '';
    content.setCustomValidity(message);
    content.setAttribute('aria-invalid', String(invalidContent));
    count.classList.toggle('is-invalid', invalidContent);
    count.textContent = message ? `${estimate.characters} / 500 字符。${message}`
      : `${estimate.characters} / 500 字符，估计 ${estimate.segments} 段（${estimate.gsm ? 'GSM 英文' : 'Unicode'}）。`;
    edit.save.disabled = state.dialogBusy || invalidContent || !content.value.trim() || !confirmation.node.checked;
  };
  content.addEventListener('input', sync);
  confirmation.node.addEventListener('change', sync);
  sync();

  edit.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.dialogBusy) return;
    const current = () => ui.dialog.open && ui.dialogContent.contains(edit.form);
    showError(edit.error);
    let body;
    let result;
    let errorControl;
    try {
      if (!confirmation.node.checked) invalid('请先确认发送设备、号码、正文与短信资费。', confirmation.node);
      const estimate = estimateSms(content.value);
      if (estimate.unsupported) invalid('正文含非 BMP 字符（如部分表情），请删除后再发送。', content);
      if (content.value.length > 500) invalid('正文不能超过 500 个 BMP 字符。', content);
      if (!content.value.trim()) invalid('请填写短信正文。', content);
      if (!source) {
        if (!devices.some((option) => String(option.value) === device.value)) invalid('请选择已启用设备。', device);
        if (!numericSmsPeer(to.value)) invalid('收件号码只能包含数字，并可用 + 开头。', to);
      }
      body = fixedBody || (source ? { request_id: requestId, content: content.value }
        : { request_id: requestId, device_id: device.value, to: to.value.trim(), content: content.value });
      attempted = true;
      setDialogBusy(true);
      for (const control of controls) control.disabled = true;
      edit.cancel.disabled = true;
      edit.save.disabled = true;
      edit.save.textContent = '正在登记…';
      result = await request(source ? `${pathFor('sms', source.id)}/reply` : '/sms', { method: 'POST', body });
      if (!record(result?.item) || !result.item.id || result.item.direction !== 'outgoing') {
        throw new Error('服务未返回已登记的短信。发送结果尚未确认，请重试同一次请求。');
      }
    } catch (failure) {
      if (!current()) return;
      result = null;
      // A lost response must not turn a retry into a second paid SMS.
      if (body && (!failure.status || failure.status >= 500 || failure.status === 409)) fixedBody = body;
      if (attempted) {
        retryNote.hidden = false;
        retryNote.textContent = fixedBody ? '结果尚未确认，本次设备、号码与正文已固定。重试会沿用同一请求 ID，请勿立即新建重复短信。'
          : '重试会沿用本次请求 ID；不会为同一次发送生成新 ID。';
      }
      showError(edit.error, failure.message);
      errorControl = failure.control;
    } finally {
      if (current()) {
        setDialogBusy(false);
        for (const control of controls) control.disabled = false;
        if (fixedBody) {
          if (device) device.disabled = true;
          if (to) to.readOnly = true;
          content.readOnly = true;
          confirmation.node.disabled = true;
        }
        edit.cancel.disabled = false;
        edit.save.textContent = fixedBody ? '重试同一短信' : attempted ? '重试发送' : '确认发送';
        sync();
      }
    }
    if (result?.item && current()) showSmsSubmission(result);
    else errorControl?.focus();
  });
  mountDialog(source ? '回复短信' : '新短信', edit.form, source ? content : device);
}

function confirmAction(title, message, label, action, onSuccess, danger = false) {
  const edit = editor(label, danger);
  edit.fields.append(element('p', 'dialog-message form-wide', message));
  submitEditor(edit, () => undefined, action, onSuccess);
  mountDialog(title, edit.form, edit.cancel);
}

function deleteResource(resource, item) {
  confirmAction(`删除${resourceNames[resource]}`, `确定删除「${item.name || item.id}」？`, '删除',
    () => request(pathFor(resource, item.id), { method: 'DELETE' }), () => {
      refreshResource(resource);
      dismissDialog();
      notify('已删除。');
    }, true);
}

function rotateDevice(item) {
  confirmAction('轮换设备令牌', `「${item.name || item.id}」的旧令牌会失效，请将新令牌填入设备配置。`, '轮换令牌',
    () => request(`${pathFor('devices', item.id)}/rotate-token`, { method: 'POST' }), (result) => {
      refreshResource('devices');
      showToken({ item, ...result }, '新令牌已生成');
    });
}

function rebindDevice(item) {
  confirmAction('重绑设备', `确认后，「${item.name || item.id}」可用新的本地凭据以同一设备 ID 重新接入。`, '确认重绑',
    async () => {
      const result = await request(`${pathFor('devices', item.id)}/rebind`, { method: 'POST' });
      if (result?.item?.id !== item.id) throw new Error('管理服务未返回更新后的设备。');
      return result.item;
    }, (updated) => {
      dismissDialog();
      const view = state.view;
      if (view?.name === 'devices') {
        view.items = view.items.map((device) => device.id === updated.id ? updated : device);
        // An in-flight list request can still contain the old state.
        if (view.loading) {
          view.read++;
          view.loading = false;
          listBusy(view);
        }
        renderList(view);
      }
      notify('已允许设备重绑。');
    });
}

async function copyField(input) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(input.value);
      return true;
    } catch {
      // Fall back to the selection when the browser denies clipboard access.
    }
  }
  input.focus();
  input.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

function showToken(result, title) {
  if (!result?.token) {
    dismissDialog();
    notify('操作已完成，服务未返回设备令牌。', true);
    return;
  }
  const content = element('div', 'token-content');
  const feedback = element('p', 'copy-status');
  feedback.role = 'status';
  content.append(element('p', '', '请现在复制令牌。关闭后无法再次查看。'));
  const values = [['设备 ID', result.item?.id], ['设备令牌', result.token], ['服务地址', window.location.origin]];
  for (const [label, value] of values) {
    const input = inputValue(value);
    input.readOnly = true;
    input.spellcheck = false;
    const box = field(label, input);
    const row = element('div', 'copy-row');
    const copy = button('复制');
    copy.setAttribute('aria-label', `复制${label}`);
    row.append(input, copy);
    box.append(row);
    copy.addEventListener('click', async () => {
      feedback.textContent = await copyField(input) ? `已复制${label}。` : `已选中${label}，请手动复制。`;
    });
    content.append(box);
  }
  content.append(feedback);
  mountDialog(title, content, ui.dialogTitle);
}

function testChannel(item) {
  const edit = editor('发送测试');
  edit.fields.append(element('p', 'dialog-message form-wide', `测试消息将发送到「${item.name || item.id}」。`));
  const { title, body } = messageControls(edit, '', '', true);
  submitEditor(edit, () => ({ title: title.value, body: body.value }),
    (payload) => request(`${pathFor('channels', item.id)}/test`, { method: 'POST', body: payload }), () => {
      dismissDialog();
      notify('测试消息已发送。');
    });
  mountDialog('测试发送', edit.form);
}

ui.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (ui.loginSubmit.disabled) return;
  showError(ui.loginError);
  const password = ui.password.value;
  ui.loginSubmit.disabled = true;
  ui.loginSubmit.textContent = '正在登录…';
  try {
    await request('/login', { method: 'POST', body: { password }, checkSession: false });
    const meta = await request('/meta', { checkSession: false });
    activate(meta, true);
  } catch (error) {
    showError(ui.loginError, error.message);
    ui.password.focus();
  } finally {
    ui.password.value = '';
    ui.loginSubmit.disabled = false;
    ui.loginSubmit.textContent = '登录';
  }
});

ui.logout.addEventListener('click', async () => {
  ui.logout.disabled = true;
  try {
    await request('/logout', { method: 'POST' });
    showLogin();
  } catch (error) {
    if (state.meta) notify(error.message, true);
  } finally {
    ui.logout.disabled = false;
  }
});

ui.refresh.addEventListener('click', async () => {
  const view = state.view;
  if (!view) return;
  state.choices.clear();
  const selected = view.selected;
  if (view.name === 'events') loadDeviceFilter(view);
  else if (view.name === 'sms') loadSmsDeviceFilter(view);
  await loadList(view);
  if (selected && state.view === view && view.selected === selected) {
    if (view.name === 'sms') {
      if (!view.smsDetailRequest) loadSmsDetail(view, selected, false);
    } else loadDetail(view, selected, false);
  }
});

ui.create.addEventListener('click', () => {
  if (!state.view) return;
  if (state.view.name === 'sms') openSmsComposer();
  else openEditor(state.view.name);
});
ui.retention.addEventListener('click', openRetentionDialog);
ui.dialogClose.addEventListener('click', dismissDialog);
ui.dialog.addEventListener('cancel', (event) => {
  if (state.dialogBusy) event.preventDefault();
});
ui.dialog.addEventListener('close', () => {
  if (ui.dialog.open) return;
  disposeHistoryDialog();
  ui.dialogContent.replaceChildren();
  syncSmsStatusRefresh(state.view, 0);
  syncDeviceStatusRefresh(state.view, 0);
  const opener = state.dialogOpener;
  state.dialogOpener = null;
  if (state.meta && document.activeElement === document.body) {
    (opener?.isConnected ? opener : ui.title).focus({ preventScroll: true });
  }
});

document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  ui.title.focus();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopSmsStatusRefresh(state.view);
    stopDeviceStatusRefresh(state.view);
  } else {
    syncSmsStatusRefresh(state.view, 0);
    syncDeviceStatusRefresh(state.view, 0);
  }
});
window.addEventListener('pagehide', () => {
  state.pageHidden = true;
  stopSmsStatusRefresh(state.view);
  stopDeviceStatusRefresh(state.view);
});
window.addEventListener('pageshow', () => {
  state.pageHidden = false;
  syncSmsStatusRefresh(state.view, 0);
  syncDeviceStatusRefresh(state.view, 0);
});
window.addEventListener('hashchange', () => { if (state.meta) openView(true); });
checkSession();

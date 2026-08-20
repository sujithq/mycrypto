import {
  isValidPortfolio,
  isValidProfile,
  normalizePortfolioInvestments,
  parseRealPortfolioJson,
  resolveProfilePortfolio,
} from './model.js';

const $ = (selector) => document.querySelector(selector);
const euro = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const PROFILES_STORAGE_KEY = 'crypto-allocation-desk.profiles.v2';

let config;
let localProfiles = [];
let activeLocalId;
let activeManagedId;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderFields(fields, portfolio, investedAmountStep = '0.01', idPrefix = 'asset', type = 'simulated') {
  fields.replaceChildren();

  portfolio.forEach((item, index) => {
    const row = element('div', 'portfolio-field management-field');
    row.dataset.thesis = item.thesis ?? '';
    const label = element('label', '', String(index + 1).padStart(2, '0'));
    label.htmlFor = `${idPrefix}-${index}`;

    const select = document.createElement('select');
    select.id = `${idPrefix}-${index}`;
    select.name = 'asset';
    select.setAttribute('aria-label', `Asset ${index + 1}`);
    config.supportedAssets.forEach((asset) => {
      const option = element('option', '', `${asset.symbol} — ${asset.name}`);
      option.value = asset.id;
      option.selected = asset.id === item.id;
      select.append(option);
    });

    const investedAmountWrap = element('div', 'invested-amount-field');
    const investedAmount = document.createElement('input');
    investedAmount.name = 'investedAmount';
    investedAmount.type = 'number';
    investedAmount.min = '0.01';
    if (type !== 'real') investedAmount.max = String(config.totalInvestment);
    investedAmount.step = investedAmountStep;
    investedAmount.value = String(item.investedAmount);
    investedAmount.setAttribute('aria-label', `Invested amount ${index + 1}`);
    investedAmountWrap.append(investedAmount);

    const quantity = document.createElement('input');
    quantity.name = 'quantity';
    quantity.type = 'number';
    quantity.min = '0.00000001';
    quantity.step = 'any';
    quantity.value = item.quantity ?? '';
    quantity.placeholder = 'Quantity';
    quantity.hidden = type !== 'real';
    quantity.required = type === 'real';
    quantity.setAttribute('aria-label', `Current quantity ${index + 1}`);

    const buyDate = document.createElement('input');
    buyDate.name = 'buyDate';
    buyDate.type = 'date';
    buyDate.value = item.buyDate ?? '';
    buyDate.setAttribute('aria-label', `Buy date ${index + 1}`);

    const remove = element('button', 'button button-quiet remove-asset', 'Remove');
    remove.type = 'button';
    remove.dataset.index = String(index);
    remove.setAttribute('aria-label', `Remove asset ${index + 1}`);

    row.append(label, select, investedAmountWrap, quantity, buyDate, remove);
    fields.append(row);
  });
}

function updateTotal(fieldsSelector, outputSelector) {
  const total = [...document.querySelectorAll(`${fieldsSelector} input[name="investedAmount"]`)]
    .map(({ value }) => Number(value))
    .reduce((sum, investedAmount) =>
      sum + (Number.isFinite(investedAmount) ? investedAmount : 0), 0);
  const output = $(outputSelector);
  output.textContent = euro.format(total);
  const isReal = fieldsSelector === '#management-fields' && $('#managed-profile-type')?.value === 'real';
  output.classList.toggle('negative', !isReal && Math.abs(total - config.totalInvestment) >= .01);
  if (fieldsSelector === '#management-fields') {
    $('#management-total-label').textContent = isReal ? 'Cost basis' : 'Allocated';
  }
}

function buildPortfolio(fieldsSelector, sourcePortfolio) {
  const fields = $(fieldsSelector);
  const rows = [...fields.querySelectorAll('.portfolio-field')];
  const ids = [...fields.querySelectorAll('select[name="asset"]')].map(({ value }) => value);
  const investedAmounts = [...fields.querySelectorAll('input[name="investedAmount"]')]
    .map(({ value }) => Number(value));
  const buyDates = [...fields.querySelectorAll('input[name="buyDate"]')].map(({ value }) => value);
  const quantities = [...fields.querySelectorAll('input[name="quantity"]')].map(({ value }) => value);

  return ids.map((id, index) => {
    const selected = config.supportedAssets.find((asset) => asset.id === id);
    const existing = sourcePortfolio.find((asset) => asset.id === id);
    return {
      ...selected,
      investedAmount: investedAmounts[index],
      ...(quantities[index] ? { quantity: Number(quantities[index]) } : {}),
      buyDate: buyDates[index] || undefined,
      thesis: existing?.thesis ?? rows[index]?.dataset.thesis ?? 'Managed default portfolio selection.',
    };
  });
}

function addAsset(fieldsSelector, totalSelector, idPrefix, investedAmountStep) {
  const current = buildPortfolio(fieldsSelector, []);
  current.push({
    ...config.supportedAssets[0],
    investedAmount: 1,
    thesis: 'Managed default portfolio selection.',
  });
  const type = fieldsSelector === '#management-fields' ? $('#managed-profile-type').value : 'simulated';
  renderFields($(fieldsSelector), current, investedAmountStep, idPrefix, type);
  updateTotal(fieldsSelector, totalSelector);
}

function removeAsset(fieldsSelector, totalSelector, idPrefix, investedAmountStep, index) {
  const current = buildPortfolio(fieldsSelector, []);
  current.splice(index, 1);
  const type = fieldsSelector === '#management-fields' ? $('#managed-profile-type').value : 'simulated';
  renderFields($(fieldsSelector), current, investedAmountStep, idPrefix, type);
  updateTotal(fieldsSelector, totalSelector);
}

function profileOption(profile, suffix = '') {
  const option = element('option', '', `${profile.name}${suffix}`);
  option.value = profile.id;
  return option;
}

function managedProfile(id) {
  return config.profiles.find((profile) => profile.id === id);
}

function loadManagedProfile(id) {
  const profile = managedProfile(id) ?? config.profiles[0];
  activeManagedId = profile.id;
  $('#managed-profile-selector').value = profile.id;
  $('#managed-profile-id').value = profile.id;
  $('#managed-profile-name').value = profile.name;
  $('#managed-profile-type').value = profile.type === 'real' ? 'real' : 'simulated';
  $('#managed-profile-buy-date').value = profile.buyDate ?? '';
  const portfolio = profile.portfolio ?? config.defaultPortfolio.map((item) => {
    if (!profile.buyDate) return item;
    const { buyDate, ...rest } = item;
    return rest;
  });
  renderFields(
    $('#management-fields'),
    portfolio,
    '0.01',
    'managed-asset',
    profile.type,
  );
  $('#real-portfolio-import').hidden = profile.type !== 'real';
  updateTotal('#management-fields', '#management-total');
}

function renderLocalProfileSelector() {
  const selector = $('#local-profile-selector');
  selector.replaceChildren(...localProfiles.map((profile) => profileOption(profile)));
  selector.value = activeLocalId ?? '';
}

function loadLocalProfile(id) {
  const profile = localProfiles.find((item) => item.id === id);
  if (!profile) return;
  activeLocalId = profile.id;
  $('#local-profile-selector').value = profile.id;
  $('#local-profile-name').value = profile.name;
  renderFields($('#portfolio-fields'), profile.portfolio, '0.01', 'local-asset');
  updateTotal('#portfolio-fields', '#allocation-total');
}

function newLocalProfile() {
  const template = managedProfile(activeManagedId) ?? config.profiles[0];
  activeLocalId = `local-${Date.now()}`;
  const profile = {
    id: activeLocalId,
    name: `${template.name} custom`,
    portfolio: structuredClone(resolveProfilePortfolio(template, config.defaultPortfolio)),
  };
  localProfiles.push(profile);
  renderLocalProfileSelector();
  loadLocalProfile(profile.id);
  $('#form-error').textContent = '';
  $('#form-status').textContent = 'New unsaved profile.';
}

function persistLocalProfiles() {
  localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(localProfiles));
}

function bindEvents() {
  const supportedIds = new Set(config.supportedAssets.map(({ id }) => id));
  localProfiles = loadLocalProfiles();
  if (localProfiles.length === 0) newLocalProfile();
  else {
    activeLocalId = localProfiles[0].id;
    renderLocalProfileSelector();
    loadLocalProfile(activeLocalId);
  }
  const managedSelector = $('#managed-profile-selector');
  managedSelector.replaceChildren(
    ...config.profiles.map((profile) => profileOption(profile, ' · read only')),
    profileOption({ id: '__new__', name: 'Create new profile' }),
  );
  loadManagedProfile(config.defaultProfileId);

  $('#portfolio-fields').addEventListener('input', () => updateTotal('#portfolio-fields', '#allocation-total'));
  $('#management-fields').addEventListener('input', () => updateTotal('#management-fields', '#management-total'));
  $('#portfolio-fields').addEventListener('click', ({ target }) => {
    if (!target.matches('.remove-asset')) return;
    removeAsset('#portfolio-fields', '#allocation-total', 'local-asset', '0.01', Number(target.dataset.index));
  });
  $('#management-fields').addEventListener('click', ({ target }) => {
    if (!target.matches('.remove-asset')) return;
    removeAsset('#management-fields', '#management-total', 'managed-asset', '0.01', Number(target.dataset.index));
  });
  $('#add-local-asset-button').addEventListener('click', () =>
    addAsset('#portfolio-fields', '#allocation-total', 'local-asset', '0.01'));
  $('#add-managed-asset-button').addEventListener('click', () =>
    addAsset('#management-fields', '#management-total', 'managed-asset', '0.01'));
  $('#local-profile-selector').addEventListener('change', ({ target }) => loadLocalProfile(target.value));
  $('#managed-profile-selector').addEventListener('change', ({ target }) => {
    if (target.value === '__new__') {
      activeManagedId = null;
      $('#managed-profile-id').value = '';
      $('#managed-profile-name').value = '';
      $('#managed-profile-type').value = 'simulated';
      $('#managed-profile-buy-date').value = '';
      renderFields($('#management-fields'), config.defaultPortfolio, '0.01', 'managed-asset');
      $('#real-portfolio-import').hidden = true;
      updateTotal('#management-fields', '#management-total');
      return;
    }
    loadManagedProfile(target.value);
  });
  $('#managed-profile-type').addEventListener('change', ({ target }) => {
    const portfolio = buildPortfolio('#management-fields', []);
    renderFields($('#management-fields'), portfolio, '0.01', 'managed-asset', target.value);
    $('#real-portfolio-import').hidden = target.value !== 'real';
    updateTotal('#management-fields', '#management-total');
  });
  $('#import-real-portfolio-button').addEventListener('click', () => {
    try {
      const imported = parseRealPortfolioJson($('#real-portfolio-json').value, config.supportedAssets);
      renderFields($('#management-fields'), imported, '0.01', 'managed-asset', 'real');
      updateTotal('#management-fields', '#management-total');
      $('#management-error').textContent = '';
    } catch (error) {
      $('#management-error').textContent = error instanceof Error
        ? error.message
        : 'Could not import the holdings JSON.';
    }
  });
  $('#new-profile-button').addEventListener('click', newLocalProfile);
  $('#delete-profile-button').addEventListener('click', () => {
    if (!activeLocalId) return;
    localProfiles = localProfiles.filter(({ id }) => id !== activeLocalId);
    try {
      persistLocalProfiles();
    } catch {
      $('#form-error').textContent = 'Could not delete the saved profile.';
      $('#form-status').textContent = '';
      return;
    }
    if (localProfiles.length === 0) newLocalProfile();
    else {
      activeLocalId = localProfiles[0].id;
      renderLocalProfileSelector();
      loadLocalProfile(activeLocalId);
    }
    $('#form-error').textContent = '';
    $('#form-status').textContent = 'Profile deleted.';
  });
  $('#portfolio-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const current = localProfiles.find(({ id }) => id === activeLocalId);
    const portfolio = buildPortfolio('#portfolio-fields', current?.portfolio ?? config.defaultPortfolio);
    const name = $('#local-profile-name').value.trim();
    if (!isValidPortfolio(portfolio, supportedIds, config.totalInvestment)) {
      $('#form-error').textContent = 'Choose one or more valid purchases with positive values totalling the configured investment. Repeated assets need different buy dates.';
      $('#form-status').textContent = '';
      return;
    }
    if (!name) {
      $('#form-error').textContent = 'Enter a profile name.';
      return;
    }
    const profile = { id: activeLocalId, name, portfolio };
    const index = localProfiles.findIndex(({ id }) => id === activeLocalId);
    if (index >= 0) localProfiles[index] = profile;
    else localProfiles.push(profile);
    try {
      persistLocalProfiles();
    } catch {
      $('#form-error').textContent = 'Could not save profiles in browser storage.';
      $('#form-status').textContent = '';
      return;
    }
    renderLocalProfileSelector();
    $('#form-error').textContent = '';
    $('#form-status').textContent = 'Local profile saved.';
  });
  $('#management-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const source = activeManagedId
      ? resolveProfilePortfolio(managedProfile(activeManagedId), config.defaultPortfolio)
      : config.defaultPortfolio;
    const portfolio = buildPortfolio('#management-fields', source);
    const profileId = $('#managed-profile-id').value.trim();
    const profileName = $('#managed-profile-name').value.trim();
    const profileBuyDate = $('#managed-profile-buy-date').value;
    const profileType = $('#managed-profile-type').value;
    const candidate = {
      id: profileId,
      name: profileName,
      type: profileType,
      ...(profileBuyDate ? { buyDate: profileBuyDate } : {}),
      portfolio,
    };
    const validProfile = isValidProfile(
      candidate,
      new Set(config.supportedAssets.map(({ id }) => id)),
      config.defaultPortfolio,
      config.totalInvestment,
    );
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(profileId) || !profileName) {
      $('#management-error').textContent = 'Use a lowercase profile ID and enter a profile name.';
      return;
    }
    if (!validProfile) {
      $('#management-error').textContent = profileType === 'real'
        ? 'Choose valid holdings with positive quantities and invested amounts. Repeated assets need different buy dates.'
        : 'Choose one or more valid purchases with positive values totalling the configured investment. Repeated assets need different buy dates.';
      return;
    }
    $('#management-error').textContent = '';
    $('#workflow-json').value = JSON.stringify(candidate, null, 2);
  });
}

function loadLocalProfiles() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILES_STORAGE_KEY));
    const supportedIds = new Set(config.supportedAssets.map(({ id }) => id));
    return Array.isArray(saved)
      ? saved.flatMap((profile) => {
        const portfolio = normalizePortfolioInvestments(profile?.portfolio);
        return profile?.id && profile?.name
          && isValidPortfolio(portfolio, supportedIds, config.totalInvestment)
          ? [{ ...profile, portfolio }]
          : [];
      })
      : [];
  } catch {
    return [];
  }
}

async function init() {
  try {
    const responses = await Promise.all([
      fetch('./data/portfolio.json', { cache: 'no-store' }),
      fetch('./profiles/index.json', { cache: 'no-store' }),
    ]);
    if (responses.some((response) => !response.ok)) {
      throw new Error('Portfolio configuration could not be loaded.');
    }
    const [portfolioConfig, fileProfiles] = await Promise.all(
      responses.map((response) => response.json()),
    );
    config = { ...portfolioConfig, profiles: fileProfiles };
    bindEvents();
  } catch (error) {
    console.error(error);
    $('#management-error').textContent = 'Management data is temporarily unavailable.';
  }
}

init();

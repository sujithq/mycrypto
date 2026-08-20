import { isValidPortfolio } from './model.js';

const $ = (selector) => document.querySelector(selector);
const euro = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const STORAGE_KEY = 'crypto-allocation-desk.portfolio.v1';

let config;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderFields(fields, portfolio, amountStep = '0.01', idPrefix = 'asset') {
  fields.replaceChildren();

  portfolio.forEach((item, index) => {
    const row = element('div', 'portfolio-field management-field');
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

    const amountWrap = element('div', 'amount-field');
    const amount = document.createElement('input');
    amount.name = 'amount';
    amount.type = 'number';
    amount.min = '1';
    amount.max = String(config.totalInvestment);
    amount.step = amountStep;
    amount.value = String(item.amount);
    amount.setAttribute('aria-label', `Actual invested value ${index + 1}`);
    amountWrap.append(amount);

    const buyDate = document.createElement('input');
    buyDate.name = 'buyDate';
    buyDate.type = 'date';
    buyDate.value = item.buyDate ?? '';
    buyDate.setAttribute('aria-label', `Buy date ${index + 1}`);

    row.append(label, select, amountWrap, buyDate);
    fields.append(row);
  });
}

function updateTotal(fieldsSelector, outputSelector) {
  const total = [...document.querySelectorAll(`${fieldsSelector} input[name="amount"]`)]
    .map(({ value }) => Number(value))
    .reduce((sum, amount) => sum + (Number.isFinite(amount) ? amount : 0), 0);
  const output = $(outputSelector);
  output.textContent = euro.format(total);
  output.classList.toggle('negative', Math.abs(total - config.totalInvestment) >= .01);
}

function buildPortfolio(fieldsSelector, sourcePortfolio) {
  const fields = $(fieldsSelector);
  const ids = [...fields.querySelectorAll('select[name="asset"]')].map(({ value }) => value);
  const amounts = [...fields.querySelectorAll('input[name="amount"]')].map(({ value }) => Number(value));
  const buyDates = [...fields.querySelectorAll('input[name="buyDate"]')].map(({ value }) => value);

  return ids.map((id, index) => {
    const selected = config.supportedAssets.find((asset) => asset.id === id);
    const existing = sourcePortfolio.find((asset) => asset.id === id);
    return {
      ...selected,
      amount: amounts[index],
      buyDate: buyDates[index] || undefined,
      thesis: existing?.thesis ?? 'Managed default portfolio selection.',
    };
  });
}

function bindEvents() {
  $('#timeframe-days').value = String(config.timeframeDays ?? 30);
  const managedIds = new Set(config.supportedAssets.map(({ id }) => id));
  let localPortfolio = loadLocalPortfolio();
  renderFields($('#portfolio-fields'), localPortfolio, '1', 'local-asset');
  renderFields($('#management-fields'), config.defaultPortfolio, '0.01', 'managed-asset');
  updateTotal('#portfolio-fields', '#allocation-total');
  updateTotal('#management-fields', '#management-total');

  $('#portfolio-fields').addEventListener('input', () => updateTotal('#portfolio-fields', '#allocation-total'));
  $('#management-fields').addEventListener('input', () => updateTotal('#management-fields', '#management-total'));
  $('#reset-button').addEventListener('click', () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      $('#form-error').textContent = 'Could not clear the saved portfolio.';
      $('#form-status').textContent = '';
      return;
    }
    localPortfolio = structuredClone(config.defaultPortfolio);
    renderFields($('#portfolio-fields'), localPortfolio, '1', 'local-asset');
    updateTotal('#portfolio-fields', '#allocation-total');
    $('#form-error').textContent = '';
    $('#form-status').textContent = 'Reset to managed defaults.';
  });
  $('#portfolio-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const portfolio = buildPortfolio('#portfolio-fields', localPortfolio);
    if (!isValidPortfolio(portfolio, managedIds, config.totalInvestment)) {
      $('#form-error').textContent = 'Choose ten unique assets with positive values totalling the configured investment.';
      $('#form-status').textContent = '';
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolio));
    } catch {
      $('#form-error').textContent = 'Could not save this portfolio in browser storage.';
      $('#form-status').textContent = '';
      return;
    }
    localPortfolio = portfolio;
    $('#form-error').textContent = '';
    $('#form-status').textContent = 'Local portfolio saved.';
  });
  $('#management-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const timeframeDays = Number($('#timeframe-days').value);
    const portfolio = buildPortfolio('#management-fields', config.defaultPortfolio);
    const validPortfolio = isValidPortfolio(portfolio, new Set(config.supportedAssets.map(({ id }) => id)), config.totalInvestment);
    if (!Number.isInteger(timeframeDays) || timeframeDays < 1 || timeframeDays > 366) {
      $('#management-error').textContent = 'Use a timeframe between 1 and 366 days.';
      return;
    }
    if (!validPortfolio) {
      $('#management-error').textContent = 'Choose ten unique assets with positive values totalling the configured investment.';
      return;
    }
    $('#management-error').textContent = '';
    $('#workflow-json').value = JSON.stringify({ timeframeDays, defaultPortfolio: portfolio }, null, 2);
  });
}

function loadLocalPortfolio() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (isValidPortfolio(saved, new Set(config.supportedAssets.map(({ id }) => id)), config.totalInvestment)) {
      return saved;
    }
  } catch {
    // Fall back to managed defaults when browser storage is unavailable.
  }
  return structuredClone(config.defaultPortfolio);
}

async function init() {
  try {
    const response = await fetch('./data/portfolio.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Portfolio configuration could not be loaded.');
    config = await response.json();
    bindEvents();
  } catch (error) {
    console.error(error);
    $('#management-error').textContent = 'Management data is temporarily unavailable.';
  }
}

init();

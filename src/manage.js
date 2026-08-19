import { isValidPortfolio } from './model.js';

const $ = (selector) => document.querySelector(selector);
const euro = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });

let config;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderFields() {
  $('#timeframe-days').value = String(config.timeframeDays ?? 30);
  const fields = $('#management-fields');
  fields.replaceChildren();

  config.defaultPortfolio.forEach((item, index) => {
    const row = element('div', 'portfolio-field management-field');
    const label = element('label', '', String(index + 1).padStart(2, '0'));
    label.htmlFor = `asset-${index}`;

    const select = document.createElement('select');
    select.id = `asset-${index}`;
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
    amount.step = '0.01';
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
  updateTotal();
}

function updateTotal() {
  const total = [...document.querySelectorAll('input[name="amount"]')]
    .map(({ value }) => Number(value))
    .reduce((sum, amount) => sum + (Number.isFinite(amount) ? amount : 0), 0);
  const output = $('#management-total');
  output.textContent = euro.format(total);
  output.classList.toggle('negative', Math.abs(total - config.totalInvestment) >= .01);
}

function buildPortfolio() {
  const ids = [...document.querySelectorAll('select[name="asset"]')].map(({ value }) => value);
  const amounts = [...document.querySelectorAll('input[name="amount"]')].map(({ value }) => Number(value));
  const buyDates = [...document.querySelectorAll('input[name="buyDate"]')].map(({ value }) => value);

  return ids.map((id, index) => {
    const selected = config.supportedAssets.find((asset) => asset.id === id);
    const existing = config.defaultPortfolio.find((asset) => asset.id === id);
    return {
      ...selected,
      amount: amounts[index],
      buyDate: buyDates[index] || undefined,
      thesis: existing?.thesis ?? 'Managed default portfolio selection.',
    };
  });
}

function bindEvents() {
  $('#management-fields').addEventListener('input', updateTotal);
  $('#management-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const timeframeDays = Number($('#timeframe-days').value);
    const portfolio = buildPortfolio();
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

async function init() {
  try {
    const response = await fetch('./data/portfolio.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Portfolio configuration could not be loaded.');
    config = await response.json();
    renderFields();
    bindEvents();
  } catch (error) {
    console.error(error);
    $('#management-error').textContent = 'Management data is temporarily unavailable.';
  }
}

init();

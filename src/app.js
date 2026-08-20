import {
  calculateHoldings,
  calculateRealHoldings,
  calculateRealSeries,
  calculateSeries,
  createAnalysisReport,
  isValidPortfolio,
  resolveProfilePortfolio,
} from './model.js';

const LEGACY_STORAGE_KEY = 'crypto-allocation-desk.portfolio.v1';
const PROFILES_STORAGE_KEY = 'crypto-allocation-desk.profiles.v2';
const ACTIVE_PROFILE_KEY = 'crypto-allocation-desk.active-profile.v2';
const $ = (selector) => document.querySelector(selector);
const euro = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const price = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 6 });
const shortDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });

let config;
let market;
let report;
let automatedReport;
let portfolio;
let activeProfile;
let profiles = [];
let chartSeries = [];

function setTrend(element, value, suffix = '%') {
  element.classList.remove('positive', 'negative');
  if (!Number.isFinite(value)) {
    element.textContent = '—';
    return;
  }
  element.textContent = `${value >= 0 ? '+' : ''}${value.toFixed(2)}${suffix}`;
  element.classList.add(value >= 0 ? 'positive' : 'negative');
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normalizePortfolio(saved) {
  const supportedIds = new Set(config.supportedAssets.map(({ id }) => id));
  if (!isValidPortfolio(saved, supportedIds, config.totalInvestment)) return null;
  return saved.map((item) => {
    const asset = config.supportedAssets.find(({ id }) => id === item.id);
    return {
      ...asset,
      amount: Number(item.amount),
      buyDate: item.buyDate,
      thesis: item.thesis ?? 'Custom selection from the tracked asset universe.',
    };
  });
}

function loadProfiles(fileProfiles) {
  const managed = fileProfiles.map((profile) => ({
    ...profile,
    source: 'managed',
    portfolio: resolveProfilePortfolio(profile, config.defaultPortfolio, config.supportedAssets),
  }));
  try {
    const local = JSON.parse(localStorage.getItem(PROFILES_STORAGE_KEY));
    const custom = Array.isArray(local)
      ? local.flatMap((profile) => {
        const normalized = normalizePortfolio(profile.portfolio);
        return normalized && profile.id && profile.name
          ? [{ ...profile, source: 'local', portfolio: normalized }]
          : [];
      })
      : [];
    const legacy = normalizePortfolio(JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY)));
    if (legacy && !custom.some(({ id }) => id === 'legacy')) {
      custom.push({ id: 'legacy', name: 'My saved portfolio', source: 'local', portfolio: legacy });
      localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(custom));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    return [...managed, ...custom];
  } catch {
    return managed;
  }
}

function selectProfile(id) {
  activeProfile = profiles.find((profile) => profile.id === id)
    ?? profiles.find((profile) => profile.id === config.defaultProfileId)
    ?? profiles[0];
  portfolio = structuredClone(activeProfile?.portfolio ?? config.defaultPortfolio);
  try {
    localStorage.setItem(ACTIVE_PROFILE_KEY, activeProfile.id);
  } catch {
    // Storage access may be denied; the selected profile still works for this page.
  }
  $('#profile-selector').value = activeProfile.id;
  const start = portfolio.map(({ buyDate }) => buyDate).filter(Boolean).sort()[0];
  $('#profile-description').textContent = activeProfile.type === 'real'
    ? `${activeProfile.name} · real holdings${start ? ` from ${start}` : ''}`
    : start
      ? `${activeProfile.name} · simulation from ${start}`
      : activeProfile.name;
  render();
}

function renderMetrics(holdings, series) {
  const invested = portfolio.reduce((sum, item) => sum + item.amount, 0);
  const valued = holdings.filter(({ value }) => Number.isFinite(value));
  const current = valued.length === holdings.length
    ? valued.reduce((sum, item) => sum + item.value, 0)
    : null;
  const totalReturnPct = current === null ? null : ((current - invested) / invested) * 100;
  const weighted24h = holdings.every(({ change24hPct }) => Number.isFinite(change24hPct))
    ? holdings.reduce((sum, item) => sum + item.change24hPct * item.amount, 0) / invested
    : null;

  $('#invested-value').textContent = euro.format(invested);
  $('#current-value').textContent = current === null ? '—' : euro.format(current);
  setTrend($('#total-return'), totalReturnPct);
  if (Number.isFinite(totalReturnPct)) {
    $('#total-return').append(activeProfile.type === 'real' ? ' total return' : ' since model start');
  }
  setTrend($('#daily-move'), weighted24h);
  $('#tracking-period').textContent = series.length
    ? `${activeProfile.type === 'real' ? 'Tracked from' : 'Model start'} ${shortDate.format(new Date(`${series[0].date}T00:00:00Z`))}`
    : `${activeProfile.type === 'real' ? 'Tracked from' : 'Model start'} —`;
}

function renderHoldings(holdings) {
  const body = $('#holdings-body');
  body.replaceChildren();
  for (const item of holdings) {
    const row = document.createElement('tr');
    const assetCell = document.createElement('td');
    const assetWrap = element('div', 'asset-cell');
    assetWrap.append(element('span', 'asset-icon', item.symbol.slice(0, 3)));
    const labels = document.createElement('span');
    labels.append(element('span', 'asset-name', item.name), element('span', 'asset-symbol', item.symbol));
    assetWrap.append(labels);
    assetCell.append(assetWrap);

    const allocationCell = document.createElement('td');
    allocationCell.append(`${euro.format(item.amount)} `);
    const bar = element('span', 'allocation-bar');
    const fill = document.createElement('i');
    const invested = portfolio.reduce((sum, holding) => sum + holding.amount, 0);
    fill.style.width = `${Math.min(100, item.amount / invested * 100)}%`;
    bar.append(fill);
    allocationCell.append(bar);

    const priceCell = element('td', '', Number.isFinite(item.price) ? price.format(item.price) : '—');
    const dayCell = element('td');
    setTrend(dayCell, item.change24hPct);
    const returnCell = element('td');
    setTrend(returnCell, item.returnPct);
    const valueCell = element('td', '', Number.isFinite(item.value) ? euro.format(item.value) : '—');
    row.append(assetCell, allocationCell, priceCell, dayCell, returnCell, valueCell);
    body.append(row);
  }
}

function renderTheses() {
  const grid = $('#thesis-grid');
  grid.replaceChildren();
  portfolio.forEach((item, index) => {
    const card = element('article', 'thesis-card');
    card.append(
      element('span', '', `${String(index + 1).padStart(2, '0')} / ${item.symbol}`),
      element('h3', '', item.name),
      element('p', '', item.thesis ?? 'Custom selection from the tracked asset universe.'),
    );
    grid.append(card);
  });

  const selectedIds = new Set(portfolio.map(({ id }) => id));
  const remaining = config.supportedAssets.filter(({ id }) => !selectedIds.has(id));
  $('#supported-assets').hidden = remaining.length === 0;
  $('#supported-assets-grid').replaceChildren(...remaining.map((item, index) => {
    const card = element('article', 'thesis-card');
    card.append(
      element('span', '', `${String(index + 1).padStart(2, '0')} / ${item.symbol}`),
      element('h3', '', item.name),
      element('p', '', item.thesis ?? 'Supported for custom portfolio allocations and included in market data updates.'),
    );
    return card;
  }));
}

function renderReport() {
  const start = report.periodStart ? shortDate.format(new Date(`${report.periodStart}T00:00:00Z`)) : '—';
  const end = report.periodEnd ? shortDate.format(new Date(`${report.periodEnd}T00:00:00Z`)) : '—';
  $('#report-period').textContent = `${start.toUpperCase()}—${end.toUpperCase()}`;
  $('#report-signal').textContent = report.status;
  $('#report-summary').textContent = report.summary;
  const best = report.bestPerformer;
  const worst = report.worstPerformer;
  $('#report-best').textContent = best ? `${best.symbol} ${best.changePct >= 0 ? '+' : ''}${best.changePct.toFixed(2)}%` : '—';
  $('#report-worst').textContent = worst ? `${worst.symbol} ${worst.changePct >= 0 ? '+' : ''}${worst.changePct.toFixed(2)}%` : '—';
  const list = $('#report-observations');
  list.replaceChildren(...report.observations.map((observation) => element('li', '', observation)));
}

function drawChart() {
  const canvas = $('#portfolio-chart');
  const empty = $('#chart-empty');
  empty.hidden = chartSeries.length > 1;
  canvas.hidden = chartSeries.length <= 1;
  if (chartSeries.length <= 1) return;

  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * scale);
  canvas.height = Math.round(rect.height * scale);
  const context = canvas.getContext('2d');
  context.scale(scale, scale);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 20, right: 10, bottom: 24, left: 52 };
  const values = chartSeries.map(({ value }) => value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const spread = Math.max(max - min, 10);
  min -= spread * .16;
  max += spread * .16;
  const x = (index) => padding.left + index / (chartSeries.length - 1) * (width - padding.left - padding.right);
  const y = (value) => padding.top + (max - value) / (max - min) * (height - padding.top - padding.bottom);

  context.font = '10px ui-monospace, monospace';
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (let index = 0; index < 4; index += 1) {
    const chartY = padding.top + index / 3 * (height - padding.top - padding.bottom);
    const label = max - index / 3 * (max - min);
    context.strokeStyle = '#20332a';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(padding.left, chartY);
    context.lineTo(width - padding.right, chartY);
    context.stroke();
    context.fillStyle = '#8aa096';
    context.fillText(`€${label.toFixed(0)}`, padding.left - 10, chartY);
  }

  const gradient = context.createLinearGradient(0, padding.top, 0, height);
  gradient.addColorStop(0, 'rgba(185, 242, 39, .18)');
  gradient.addColorStop(1, 'rgba(185, 242, 39, 0)');
  context.beginPath();
  chartSeries.forEach((point, index) => {
    if (index === 0) context.moveTo(x(index), y(point.value));
    else context.lineTo(x(index), y(point.value));
  });
  context.lineTo(x(chartSeries.length - 1), height - padding.bottom);
  context.lineTo(x(0), height - padding.bottom);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  chartSeries.forEach((point, index) => {
    if (index === 0) context.moveTo(x(index), y(point.value));
    else context.lineTo(x(index), y(point.value));
  });
  context.strokeStyle = '#b9f227';
  context.lineWidth = 2;
  context.stroke();
  const last = chartSeries.at(-1);
  context.beginPath();
  context.arc(x(chartSeries.length - 1), y(last.value), 4, 0, Math.PI * 2);
  context.fillStyle = '#b9f227';
  context.fill();

  $('#chart-start').textContent = shortDate.format(new Date(`${chartSeries[0].date}T00:00:00Z`)).toUpperCase();
  $('#chart-end').textContent = shortDate.format(new Date(`${last.date}T00:00:00Z`)).toUpperCase();
  canvas.setAttribute('aria-label', `Portfolio value from ${euro.format(chartSeries[0].value)} on ${chartSeries[0].date} to ${euro.format(last.value)} on ${last.date}.`);
}

function render() {
  $('#holdings-title').textContent = `${portfolio.length} portfolio ${portfolio.length === 1 ? 'asset' : 'assets'}`;
  const isReal = activeProfile.type === 'real';
  chartSeries = isReal
    ? calculateRealSeries(portfolio, market.history, config.timeframeDays)
    : calculateSeries(portfolio, market.history, config.timeframeDays);
  const holdings = isReal
    ? calculateRealHoldings(portfolio, market.assets)
    : calculateHoldings(portfolio, market.history, market.assets);
  const isDefaultPortfolio = portfolio.every((item, index) =>
    item.id === config.defaultPortfolio[index]?.id
    && item.amount === config.defaultPortfolio[index]?.amount
    && (item.buyDate ?? null) === (config.defaultPortfolio[index]?.buyDate ?? null));
  report = !isReal && isDefaultPortfolio
    ? automatedReport
    : createAnalysisReport(market.history, portfolio, new Date().toISOString(), config.timeframeDays);
  $('#page-kicker').textContent = isReal ? 'REAL PORTFOLIO · MANAGED' : 'MODEL PORTFOLIO · AGGRESSIVE';
  $('#portfolio-brief').textContent = isReal
    ? 'Actual holdings entered manually and marked using the latest available EUR prices.'
    : 'A hypothetical €500 allocation tracked at the daily UTC close. Built for perspective—not predictions.';
  $('#chart-legend-label').textContent = isReal ? 'Market value' : 'Model value';
  renderMetrics(holdings, chartSeries);
  renderHoldings(holdings);
  renderTheses();
  renderReport();
  drawChart();
}

function bindEvents() {
  window.addEventListener('resize', drawChart);
  $('#profile-selector').addEventListener('change', ({ target }) => selectProfile(target.value));
}

async function init() {
  try {
    const responses = await Promise.all([
      fetch('./data/portfolio.json'),
      fetch('./data/market.json', { cache: 'no-store' }),
      fetch('./data/weekly-report.json', { cache: 'no-store' }),
      fetch('./profiles/index.json', { cache: 'no-store' }),
    ]);
    if (responses.some((response) => !response.ok)) throw new Error('Dashboard data could not be loaded.');
    [config, market, automatedReport, profiles] = await Promise.all(responses.map((response) => response.json()));
    profiles = loadProfiles(profiles);
    const selector = $('#profile-selector');
    selector.replaceChildren(...profiles.map((profile) => {
      const option = element('option', '', `${profile.name}${profile.source === 'local' ? ' · local' : ''}`);
      option.value = profile.id;
      return option;
    }));
    let savedProfileId;
    try {
      savedProfileId = localStorage.getItem(ACTIVE_PROFILE_KEY);
    } catch {
      // Use the managed default when storage access is denied.
    }
    activeProfile = profiles.find(({ id }) => id === savedProfileId)
      ?? profiles.find(({ id }) => id === config.defaultProfileId)
      ?? profiles[0];
    portfolio = structuredClone(activeProfile?.portfolio ?? config.defaultPortfolio);
    selector.value = activeProfile?.id ?? '';
    const start = portfolio.map(({ buyDate }) => buyDate).filter(Boolean).sort()[0];
    $('#profile-description').textContent = activeProfile.type === 'real'
      ? `${activeProfile.name} · real holdings${start ? ` from ${start}` : ''}`
      : start
        ? `${activeProfile.name} · simulation from ${start}`
        : activeProfile.name;
    report = automatedReport;
    $('#data-status').textContent = market.updatedAt
      ? `${shortDate.format(new Date(market.updatedAt)).toUpperCase()} UTC`
      : 'AWAITING UPDATE';
    bindEvents();
    render();
  } catch (error) {
    console.error(error);
    $('#data-status').textContent = 'UNAVAILABLE';
    $('#chart-empty').hidden = false;
    $('#chart-empty').textContent = 'Dashboard data is temporarily unavailable.';
  }
}

init();

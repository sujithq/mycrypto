import {
  calculateAssetSeries,
  calculateHoldings,
  calculateRealHoldings,
  calculateRealSeries,
  calculateSeries,
  createAnalysisReport,
  filterSeriesByRange,
  isValidPortfolio,
  normalizePortfolioInvestments,
  resolveProfilePortfolio,
} from './model.js';

const LEGACY_STORAGE_KEY = 'crypto-allocation-desk.portfolio.v1';
const PROFILES_STORAGE_KEY = 'crypto-allocation-desk.profiles.v2';
const ACTIVE_PROFILE_KEY = 'crypto-allocation-desk.active-profile.v2';
const $ = (selector) => document.querySelector(selector);
const euro = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const price = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 6 });
const quantity = new Intl.NumberFormat('en-IE', { maximumSignificantDigits: 8 });
const shortDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const detailDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const RANGE_LABELS = {
  '1d': '1 day',
  '1w': '1 week',
  '1m': '1 month',
  '1y': '1 year',
  ytd: 'Year to date',
  all: 'Since purchase',
};

let config;
let market;
let report;
let profileReports;
let portfolio;
let activeProfile;
let profiles = [];
let chartSeries = [];
let holdings = [];
let activeAssetIndex = null;
let lastAssetIndex = null;
let assetSeries = [];
let assetRange = 'all';

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

function normalizeSavedPortfolio(saved) {
  const normalized = normalizePortfolioInvestments(saved);
  const supportedIds = new Set(config.supportedAssets.map(({ id }) => id));
  if (!isValidPortfolio(normalized, supportedIds, config.totalInvestment)) return null;
  return normalized.map((item) => {
    const asset = config.supportedAssets.find(({ id }) => id === item.id);
    return {
      ...asset,
      investedAmount: Number(item.investedAmount),
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
        const normalized = normalizeSavedPortfolio(profile.portfolio);
        return normalized && profile.id && profile.name
          ? [{ ...profile, source: 'local', portfolio: normalized }]
          : [];
      })
      : [];
    const legacy = normalizeSavedPortfolio(JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY)));
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
  const invested = portfolio.reduce((sum, item) => sum + item.investedAmount, 0);
  const valued = holdings.filter(({ value }) => Number.isFinite(value));
  const current = valued.length === holdings.length
    ? valued.reduce((sum, item) => sum + item.value, 0)
    : null;
  const totalReturnPct = current === null ? null : ((current - invested) / invested) * 100;
  const weighted24h = holdings.every(({ change24hPct }) => Number.isFinite(change24hPct))
    ? holdings.reduce((sum, item) => sum + item.change24hPct * item.investedAmount, 0) / invested
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
  holdings.forEach((item, index) => {
    const row = document.createElement('tr');
    const assetCell = document.createElement('td');
    const assetWrap = element('div', 'asset-cell');
    assetWrap.append(element('span', 'asset-icon', item.symbol.slice(0, 3)));
    const labels = document.createElement('span');
    labels.append(element('span', 'asset-name', item.name), element('span', 'asset-symbol', item.symbol));
    assetWrap.append(labels);
    const assetLink = element('button', 'asset-link');
    assetLink.type = 'button';
    assetLink.dataset.assetIndex = String(index);
    assetLink.setAttribute('aria-label', `View ${item.name} evolution${item.buyDate ? ` from ${item.buyDate}` : ''}`);
    assetLink.append(assetWrap);
    assetCell.append(assetLink);

    const allocationCell = document.createElement('td');
    allocationCell.append(`${euro.format(item.investedAmount)} `);
    const bar = element('span', 'allocation-bar');
    const fill = document.createElement('i');
    const invested = portfolio.reduce((sum, holding) => sum + holding.investedAmount, 0);
    fill.style.width = `${Math.min(100, item.investedAmount / invested * 100)}%`;
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
  });
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
  $('#report-profile').textContent = activeProfile.name.toUpperCase();
  $('#report-title').textContent = `${activeProfile.name} analysis`;
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

function drawValueChart({ canvas, empty, series, startOutput, endOutput, seriesLabel, dateFormat = shortDate }) {
  empty.hidden = series.length > 1;
  canvas.hidden = series.length <= 1;
  startOutput.textContent = series[0]
    ? dateFormat.format(new Date(`${series[0].date}T00:00:00Z`)).toUpperCase()
    : '—';
  endOutput.textContent = series.at(-1)
    ? dateFormat.format(new Date(`${series.at(-1).date}T00:00:00Z`)).toUpperCase()
    : '—';
  if (series.length <= 1) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * scale);
  canvas.height = Math.round(rect.height * scale);
  const context = canvas.getContext('2d');
  context.scale(scale, scale);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 20, right: 10, bottom: 24, left: 52 };
  const values = series.map(({ value }) => value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const spread = Math.max(max - min, Math.abs(max) * .05, 1);
  min -= spread * .16;
  max += spread * .16;
  const x = (index) => padding.left + index / (series.length - 1) * (width - padding.left - padding.right);
  const y = (value) => padding.top + (max - value) / (max - min) * (height - padding.top - padding.bottom);
  const axisValue = new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: max < 10 ? 2 : 0,
  });

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
    context.fillText(axisValue.format(label), padding.left - 10, chartY);
  }

  const gradient = context.createLinearGradient(0, padding.top, 0, height);
  gradient.addColorStop(0, 'rgba(185, 242, 39, .18)');
  gradient.addColorStop(1, 'rgba(185, 242, 39, 0)');
  context.beginPath();
  series.forEach((point, index) => {
    if (index === 0) context.moveTo(x(index), y(point.value));
    else context.lineTo(x(index), y(point.value));
  });
  context.lineTo(x(series.length - 1), height - padding.bottom);
  context.lineTo(x(0), height - padding.bottom);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  series.forEach((point, index) => {
    if (index === 0) context.moveTo(x(index), y(point.value));
    else context.lineTo(x(index), y(point.value));
  });
  context.strokeStyle = '#b9f227';
  context.lineWidth = 2;
  context.stroke();
  const last = series.at(-1);
  context.beginPath();
  context.arc(x(series.length - 1), y(last.value), 4, 0, Math.PI * 2);
  context.fillStyle = '#b9f227';
  context.fill();

  canvas.setAttribute('aria-label', `${seriesLabel} from ${euro.format(series[0].value)} on ${series[0].date} to ${euro.format(last.value)} on ${last.date}.`);
}

function drawChart() {
  drawValueChart({
    canvas: $('#portfolio-chart'),
    empty: $('#chart-empty'),
    series: chartSeries,
    startOutput: $('#chart-start'),
    endOutput: $('#chart-end'),
    seriesLabel: 'Portfolio value',
  });
}

function renderAssetRange() {
  const visibleSeries = filterSeriesByRange(assetSeries, assetRange);
  document.querySelectorAll('#asset-range-control [data-range]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.range === assetRange));
  });
  $('#asset-range-label').textContent = RANGE_LABELS[assetRange];
  const first = visibleSeries[0]?.value;
  const last = visibleSeries.at(-1)?.value;
  const rangeReturn = Number.isFinite(first) && first > 0 && Number.isFinite(last)
    ? ((last - first) / first) * 100
    : null;
  setTrend($('#asset-range-return'), rangeReturn);
  drawValueChart({
    canvas: $('#asset-chart'),
    empty: $('#asset-chart-empty'),
    series: visibleSeries,
    startOutput: $('#asset-chart-start'),
    endOutput: $('#asset-chart-end'),
    seriesLabel: `${holdings[activeAssetIndex]?.name ?? 'Asset'} position value`,
    dateFormat: detailDate,
  });
}

function showAssetDetail(index) {
  const item = holdings[index];
  const portfolioItem = portfolio[index];
  if (!item || !portfolioItem) return false;
  activeAssetIndex = index;
  lastAssetIndex = index;
  assetRange = 'all';
  assetSeries = calculateAssetSeries(portfolioItem, market.history, activeProfile.type === 'real');
  const firstDate = portfolioItem.buyDate ?? assetSeries[0]?.date;
  const lastDate = assetSeries.at(-1)?.date;

  $('#asset-detail-kicker').textContent = `${item.symbol} · ${activeProfile.name}`.toUpperCase();
  $('#asset-detail-title').textContent = `${item.name} evolution`;
  $('#asset-detail-mark').textContent = item.symbol.slice(0, 4);
  $('#asset-detail-period').textContent = firstDate
    ? `Daily EUR closes from ${detailDate.format(new Date(`${firstDate}T00:00:00Z`))}${lastDate ? ` through ${detailDate.format(new Date(`${lastDate}T00:00:00Z`))}` : ''}.`
    : 'Waiting for the first daily close.';
  $('#asset-current-value').textContent = Number.isFinite(item.value) ? euro.format(item.value) : '—';
  $('#asset-current-date').textContent = lastDate
    ? `Close ${detailDate.format(new Date(`${lastDate}T00:00:00Z`))}`
    : 'Latest daily close unavailable';
  setTrend($('#asset-total-return'), item.returnPct);
  $('#asset-buy-date').textContent = firstDate
    ? `Purchased ${detailDate.format(new Date(`${firstDate}T00:00:00Z`))}`
    : 'Purchase date unavailable';
  $('#asset-invested-value').textContent = euro.format(item.investedAmount);
  $('#asset-quantity').textContent = Number.isFinite(Number(item.quantity))
    ? `${quantity.format(Number(item.quantity))} ${item.symbol}`
    : `Baseline ${Number.isFinite(item.startPrice) ? price.format(item.startPrice) : '—'}`;
  $('#asset-current-price').textContent = Number.isFinite(item.price) ? price.format(item.price) : '—';
  setTrend($('#asset-daily-move'), item.change24hPct);
  document.querySelectorAll('[data-portfolio-view]').forEach((section) => { section.hidden = true; });
  $('#asset-detail').hidden = false;
  $('#asset-back').focus({ preventScroll: true });
  document.title = `${item.symbol} evolution · Crypto Allocation Desk`;
  requestAnimationFrame(renderAssetRange);
  return true;
}

function showPortfolioView(restoreScroll) {
  activeAssetIndex = null;
  assetSeries = [];
  $('#asset-detail').hidden = true;
  document.querySelectorAll('[data-portfolio-view]').forEach((section) => { section.hidden = false; });
  document.title = 'Crypto Allocation Desk';
  requestAnimationFrame(() => {
    drawChart();
    if (Number.isFinite(restoreScroll)) window.scrollTo(0, restoreScroll);
    if (Number.isInteger(lastAssetIndex)) {
      $(`[data-asset-index="${lastAssetIndex}"]`)?.focus({ preventScroll: true });
    }
  });
}

function syncViewFromLocation(restorePortfolioScroll = false) {
  const url = new URL(window.location.href);
  const rawIndex = url.searchParams.get('asset');
  const index = /^\d+$/.test(rawIndex ?? '') ? Number(rawIndex) : null;
  if (index !== null && showAssetDetail(index)) {
    window.scrollTo(0, 0);
    return;
  }
  if (rawIndex !== null) {
    url.searchParams.delete('asset');
    history.replaceState(history.state, '', url);
  }
  showPortfolioView(restorePortfolioScroll ? history.state?.portfolioScrollY : undefined);
}

function openAssetDetail(index) {
  history.replaceState({ ...history.state, portfolioScrollY: window.scrollY }, '', window.location.href);
  const url = new URL(window.location.href);
  url.searchParams.set('asset', String(index));
  history.pushState({ assetDetail: true }, '', url);
  showAssetDetail(index);
  window.scrollTo(0, 0);
}

function closeAssetDetail() {
  if (history.state?.assetDetail) {
    history.back();
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.delete('asset');
  history.replaceState(history.state, '', url);
  showPortfolioView();
}

function render() {
  $('#holdings-title').textContent = `${portfolio.length} portfolio ${portfolio.length === 1 ? 'asset' : 'assets'}`;
  const isReal = activeProfile.type === 'real';
  chartSeries = isReal
    ? calculateRealSeries(portfolio, market.history, config.timeframeDays)
    : calculateSeries(portfolio, market.history, config.timeframeDays);
  holdings = isReal
    ? calculateRealHoldings(portfolio, market.assets)
    : calculateHoldings(portfolio, market.history, market.assets);
  report = activeProfile.source === 'managed'
    ? profileReports.reports?.[activeProfile.id]
    : null;
  report ??= createAnalysisReport(
    market.history,
    portfolio,
    market.updatedAt ?? new Date().toISOString(),
    config.timeframeDays,
  );
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
  window.addEventListener('resize', () => {
    if (activeAssetIndex === null) drawChart();
    else renderAssetRange();
  });
  window.addEventListener('popstate', () => syncViewFromLocation(true));
  $('#profile-selector').addEventListener('change', ({ target }) => selectProfile(target.value));
  $('#holdings-body').addEventListener('click', ({ target }) => {
    const trigger = target.closest('[data-asset-index]');
    if (trigger) openAssetDetail(Number(trigger.dataset.assetIndex));
  });
  $('#asset-back').addEventListener('click', closeAssetDetail);
  $('#asset-range-control').addEventListener('click', ({ target }) => {
    const trigger = target.closest('[data-range]');
    if (!trigger) return;
    assetRange = trigger.dataset.range;
    renderAssetRange();
  });
  document.addEventListener('keydown', ({ key }) => {
    if (key === 'Escape' && activeAssetIndex !== null) closeAssetDetail();
  });
}

async function init() {
  try {
    const responses = await Promise.all([
      fetch('./data/portfolio.json'),
      fetch('./data/market.json', { cache: 'no-store' }),
      fetch('./data/profile-reports.json', { cache: 'no-store' }),
      fetch('./profiles/index.json', { cache: 'no-store' }),
    ]);
    if (responses.some((response) => !response.ok)) throw new Error('Dashboard data could not be loaded.');
    [config, market, profileReports, profiles] = await Promise.all(responses.map((response) => response.json()));
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
    $('#data-status').textContent = market.updatedAt
      ? `${shortDate.format(new Date(market.updatedAt)).toUpperCase()} UTC`
      : 'AWAITING UPDATE';
    bindEvents();
    render();
    syncViewFromLocation();
  } catch (error) {
    console.error(error);
    $('#data-status').textContent = 'UNAVAILABLE';
    $('#chart-empty').hidden = false;
    $('#chart-empty').textContent = 'Dashboard data is temporarily unavailable.';
  }
}

init();

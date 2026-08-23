export function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function normalizePortfolioInvestments(portfolio) {
  if (!Array.isArray(portfolio)) return portfolio;
  return portfolio.map(({ amount, ...item }) => ({
    ...item,
    investedAmount: item.investedAmount ?? amount,
  }));
}

export function isValidPortfolio(portfolio, supportedIds, target = 500) {
  if (!Array.isArray(portfolio) || portfolio.length === 0) return false;
  const ids = portfolio.map(({ id }) => id);
  if (ids.some((id) => !supportedIds.has(id))) return false;
  const investedAmounts = portfolio.map(({ investedAmount }) => Number(investedAmount));
  const dates = portfolio.map(({ buyDate }) => buyDate).filter(Boolean);
  const purchases = portfolio.map(({ id, buyDate }) => `${id}:${buyDate ?? ''}`);
  const repeatedIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (repeatedIds.some((id) =>
    portfolio.some((item) => item.id === id && !item.buyDate))
    || new Set(purchases).size !== purchases.length) return false;
  return investedAmounts.every((investedAmount) =>
    Number.isFinite(investedAmount) && investedAmount > 0)
    && dates.every(isValidDate)
    && Math.abs(investedAmounts.reduce((sum, investedAmount) => sum + investedAmount, 0) - target) < 0.01;
}

export function isValidRealPortfolio(portfolio, supportedIds) {
  if (!Array.isArray(portfolio) || portfolio.length === 0) return false;
  const ids = portfolio.map(({ id }) => id);
  const purchases = portfolio.map(({ id, buyDate }) => `${id}:${buyDate ?? ''}`);
  const dates = portfolio.map(({ buyDate }) => buyDate).filter(Boolean);
  return ids.every((id) => supportedIds.has(id))
    && portfolio.every(({ investedAmount, quantity }) =>
      Number.isFinite(Number(investedAmount)) && Number(investedAmount) > 0
      && Number.isFinite(Number(quantity)) && Number(quantity) > 0)
    && dates.every(isValidDate)
    && new Set(purchases).size === purchases.length;
}

export function resolveProfilePortfolio(profile, defaultPortfolio, supportedAssets = []) {
  const source = profile?.portfolio ?? defaultPortfolio;
  return source.map((item) => ({
    ...supportedAssets.find(({ id }) => id === item.id),
    ...defaultPortfolio.find(({ id }) => id === item.id),
    ...item,
    ...(profile?.buyDate && (!profile.portfolio || !item.buyDate)
      ? { buyDate: profile.buyDate }
      : {}),
  }));
}

export function isValidProfile(profile, supportedIds, defaultPortfolio, target = 500) {
  return Boolean(
    profile
    && /^[a-z0-9][a-z0-9-]{0,39}$/.test(profile.id)
    && typeof profile.name === 'string'
    && profile.name.trim()
    && (!profile.buyDate || isValidDate(profile.buyDate))
    && (profile.type === 'real'
      ? isValidRealPortfolio(resolveProfilePortfolio(profile, defaultPortfolio), supportedIds)
      : (!profile.type || profile.type === 'simulated')
        && isValidPortfolio(resolveProfilePortfolio(profile, defaultPortfolio), supportedIds, target)),
  );
}

export function parseRealPortfolioJson(raw, supportedAssets) {
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed)
    ? parsed
    : parsed?.portfolio ?? parsed?.profile?.portfolio;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Paste a JSON array of holdings or generated profile JSON.');
  }
  return items.map((item) => {
    const key = String(item.id ?? item.symbol ?? '').toLowerCase();
    const asset = supportedAssets.find(({ id, symbol }) =>
      id.toLowerCase() === key || symbol.toLowerCase() === key);
    if (!asset) throw new Error(`Unsupported asset: ${item.id ?? item.symbol ?? 'unknown'}`);
    const investedAmount = Number(item.investedAmount ?? item.amount ?? item.cost ?? item.actualCost);
    const quantity = Number(item.quantity);
    if (!Number.isFinite(investedAmount) || investedAmount <= 0
      || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`${asset.symbol} needs a positive quantity and invested amount.`);
    }
    return {
      ...asset,
      investedAmount,
      quantity,
      ...(item.buyDate ? { buyDate: item.buyDate } : {}),
      thesis: typeof item.thesis === 'string' && item.thesis.trim()
        ? item.thesis.trim()
        : 'Manually managed real portfolio holding.',
    };
  });
}

export function getBaselinePrices(portfolio, history) {
  return portfolio.map(({ id, buyDate }) => {
    const first = history.find((entry) =>
      (!buyDate || entry.date >= buyDate) && Number.isFinite(entry.prices?.[id]));
    return first?.prices[id] ?? null;
  });
}

export function filterHistoryByTimeframe(history, timeframeDays) {
  const days = Number(timeframeDays);
  if (!Number.isFinite(days) || days <= 0 || history.length === 0) return history;
  const end = history.at(-1)?.date;
  if (!end) return history;
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - Math.floor(days));
  const startDate = start.toISOString().slice(0, 10);
  return history.filter((entry) => entry.date >= startDate);
}

export function calculateSeries(portfolio, history, timeframeDays) {
  const baseline = getBaselinePrices(portfolio, history);
  return filterHistoryByTimeframe(history, timeframeDays).flatMap((entry) => {
    const values = portfolio.map(({ id, investedAmount, buyDate }, index) => {
      const startPrice = baseline[index];
      const price = entry.prices?.[id];
      return (!buyDate || entry.date >= buyDate) && Number.isFinite(startPrice) && Number.isFinite(price) && startPrice > 0
        ? investedAmount * (price / startPrice)
        : null;
    });
    const total = values.reduce((sum, value) => sum + value, 0);
    return values.some((value) => value === null)
      ? []
      : [{ date: entry.date, value: Math.round(total * 100) / 100 }];
  });
}

export function calculateAssetSeries(asset, history) {
  const quantity = Number(asset.quantity);
  let units = quantity;
  if (!Number.isFinite(units) || units <= 0) {
    const positionStartPrice = Number(asset.startPrice);
    const baselinePrice = Number.isFinite(positionStartPrice) && positionStartPrice > 0
      ? positionStartPrice
      : getBaselinePrices([asset], history)[0];
    units = Number(asset.investedAmount) / baselinePrice;
  }
  if (!Number.isFinite(units) || units <= 0) return [];

  return history.flatMap((entry) => {
    const marketPrice = entry.prices?.[asset.id];
    if ((asset.buyDate && entry.date < asset.buyDate)
      || !Number.isFinite(marketPrice)
      || marketPrice <= 0) return [];
    const value = units * marketPrice;
    return Number.isFinite(value)
      ? [{ date: entry.date, value: Math.round(value * 100) / 100 }]
      : [];
  });
}

export function calculateAssetPriceSeries(asset, history) {
  return history.flatMap((entry) => {
    const marketPrice = entry.prices?.[asset.id];
    return (!asset.buyDate || entry.date >= asset.buyDate)
      && Number.isFinite(marketPrice)
      && marketPrice > 0
      ? [{ date: entry.date, value: marketPrice }]
      : [];
  });
}

export function filterSeriesByRange(series, range) {
  if (range === 'all' || series.length === 0) return series;
  const endDate = series.at(-1)?.date;
  if (!endDate) return series;
  const start = new Date(`${endDate}T00:00:00Z`);
  if (range === '1d') start.setUTCDate(start.getUTCDate() - 1);
  else if (range === '1w') start.setUTCDate(start.getUTCDate() - 7);
  else if (range === '1m') start.setUTCMonth(start.getUTCMonth() - 1);
  else if (range === '1y') start.setUTCFullYear(start.getUTCFullYear() - 1);
  else if (range === '3y') start.setUTCFullYear(start.getUTCFullYear() - 3);
  else if (range === '5y') start.setUTCFullYear(start.getUTCFullYear() - 5);
  else if (range === '10y') start.setUTCFullYear(start.getUTCFullYear() - 10);
  else if (range === 'ytd') start.setUTCMonth(0, 1);
  else return series;
  const startDate = start.toISOString().slice(0, 10);
  return series.filter(({ date }) => date >= startDate);
}

export function calculateHoldings(portfolio, history, assets) {
  const baseline = getBaselinePrices(portfolio, history);
  return portfolio.map((item, index) => {
    const quote = assets[item.id] ?? {};
    const startPrice = baseline[index];
    const currentPrice = quote.price;
    const value = Number.isFinite(startPrice) && startPrice > 0 && Number.isFinite(currentPrice)
      ? item.investedAmount * (currentPrice / startPrice)
      : null;
    const returnPct = value === null
      ? null
      : ((value - item.investedAmount) / item.investedAmount) * 100;
    return { ...item, ...quote, startPrice, value, returnPct };
  });
}

export function calculateRealSeries(portfolio, history, timeframeDays) {
  return filterHistoryByTimeframe(history, timeframeDays).flatMap((entry) => {
    const active = portfolio.filter(({ buyDate }) => !buyDate || entry.date >= buyDate);
    if (active.length === 0 || active.some(({ id }) => !Number.isFinite(entry.prices?.[id]))) return [];
    const value = active.reduce((sum, item) => sum + Number(item.quantity) * entry.prices[item.id], 0);
    return [{ date: entry.date, value: Math.round(value * 100) / 100 }];
  });
}

export function calculateRealHoldings(portfolio, assets) {
  return portfolio.map((item) => {
    const quote = assets[item.id] ?? {};
    const value = Number.isFinite(quote.price) ? Number(item.quantity) * quote.price : null;
    const returnPct = value === null
      ? null
      : ((value - item.investedAmount) / item.investedAmount) * 100;
    return {
      ...item,
      ...quote,
      startPrice: item.investedAmount / item.quantity,
      value,
      returnPct,
    };
  });
}

export function createAnalysisReport(history, portfolio, generatedAt = new Date().toISOString(), timeframeDays = 7) {
  const latestBuyDate = portfolio.map(({ buyDate }) => buyDate).filter(Boolean).sort().at(-1);
  const recent = filterHistoryByTimeframe(history, timeframeDays)
    .filter((entry) => !latestBuyDate || entry.date >= latestBuyDate);
  if (recent.length < 2) {
    return {
      generatedAt,
      periodStart: recent[0]?.date ?? null,
      periodEnd: recent.at(-1)?.date ?? null,
      status: 'Collecting data',
      summary: 'At least two daily closes are needed before performance can be analysed.',
      portfolioChangePct: null,
      bestPerformer: null,
      worstPerformer: null,
      observations: [`The report will become more reliable after ${timeframeDays + 1} daily closes.`],
    };
  }

  const start = recent[0];
  const end = recent.at(-1);
  const changes = portfolio.flatMap((asset) => {
    const assetStart = asset.buyDate
      ? recent.find((entry) => entry.date >= asset.buyDate && Number.isFinite(entry.prices[asset.id]))
      : start;
    const startPrice = assetStart?.prices[asset.id];
    const endPrice = end.prices[asset.id];
    if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice) || startPrice <= 0) return [];
    return [{
      symbol: asset.symbol,
      investedAmount: asset.investedAmount,
      changePct: ((endPrice - startPrice) / startPrice) * 100,
    }];
  });
  if (changes.length !== portfolio.length) {
    return {
      generatedAt,
      periodStart: start.date,
      periodEnd: end.date,
      status: 'Insufficient data',
      summary: 'Comparable prices were not available for every portfolio asset.',
      portfolioChangePct: null,
      bestPerformer: null,
      worstPerformer: null,
      observations: ['The report will be published when every portfolio asset has comparable prices.'],
    };
  }
  const totalInvestedAmount = changes.reduce((sum, asset) => sum + asset.investedAmount, 0);
  const portfolioChangePct = totalInvestedAmount
    ? changes.reduce((sum, asset) => sum + asset.changePct * asset.investedAmount, 0) / totalInvestedAmount
    : null;
  const ranked = [...changes].sort((a, b) => b.changePct - a.changePct);
  const best = ranked[0] ?? null;
  const worst = ranked.at(-1) ?? null;
  const status = portfolioChangePct === null
    ? 'Insufficient data'
    : portfolioChangePct >= 5
      ? 'Strong momentum'
      : portfolioChangePct <= -5
        ? 'Risk-off'
        : 'Range-bound';

  return {
    generatedAt,
    periodStart: start.date,
    periodEnd: end.date,
    status,
    summary: portfolioChangePct === null
      ? 'No comparable prices were available.'
      : `The portfolio moved ${portfolioChangePct >= 0 ? '+' : ''}${portfolioChangePct.toFixed(2)}% over a ${timeframeDays}-day trailing window (${recent.length} closes).`,
    portfolioChangePct: portfolioChangePct === null ? null : Number(portfolioChangePct.toFixed(4)),
    bestPerformer: best ? { symbol: best.symbol, changePct: Number(best.changePct.toFixed(4)) } : null,
    worstPerformer: worst ? { symbol: worst.symbol, changePct: Number(worst.changePct.toFixed(4)) } : null,
    observations: [
      best ? `${best.symbol} led the portfolio at ${best.changePct >= 0 ? '+' : ''}${best.changePct.toFixed(2)}%.` : 'No leader could be calculated.',
      worst ? `${worst.symbol} was weakest at ${worst.changePct >= 0 ? '+' : ''}${worst.changePct.toFixed(2)}%.` : 'No laggard could be calculated.',
      recent.length < timeframeDays + 1
        ? `This early report uses ${recent.length} closes; the target ${timeframeDays}-day window has ${timeframeDays + 1}.`
        : `Performance is allocation-weighted across the ${timeframeDays}-day trailing window (${recent.length} closes).`,
      'Momentum is descriptive, not predictive; review concentration and downside before acting.',
    ],
  };
}

export function createProfileReports(history, profiles, config, generatedAt = new Date().toISOString()) {
  return {
    generatedAt,
    reports: Object.fromEntries(profiles.map((profile) => {
      const portfolio = resolveProfilePortfolio(
        profile,
        config.defaultPortfolio,
        config.supportedAssets,
      );
      return [profile.id, {
        profile: {
          id: profile.id,
          name: profile.name,
          type: profile.type ?? 'simulated',
        },
        ...createAnalysisReport(history, portfolio, generatedAt, config.timeframeDays),
      }];
    })),
  };
}

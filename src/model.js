export function isValidPortfolio(portfolio, supportedIds, target = 500) {
  if (!Array.isArray(portfolio) || portfolio.length !== 10) return false;
  const ids = portfolio.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !supportedIds.has(id))) return false;
  const amounts = portfolio.map(({ amount }) => Number(amount));
  const dates = portfolio.map(({ buyDate }) => buyDate).filter(Boolean);
  const validDate = (date) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  };
  return amounts.every((amount) => Number.isFinite(amount) && amount > 0)
    && dates.every(validDate)
    && Math.abs(amounts.reduce((sum, amount) => sum + amount, 0) - target) < 0.01;
}

export function getBaselinePrices(portfolio, history) {
  return Object.fromEntries(portfolio.map(({ id }) => {
    const buyDate = portfolio.find((asset) => asset.id === id)?.buyDate;
    const first = history.find((entry) =>
      (!buyDate || entry.date >= buyDate) && Number.isFinite(entry.prices?.[id]));
    return [id, first?.prices[id] ?? null];
  }));
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
    const values = portfolio.map(({ id, amount, buyDate }) => {
      const startPrice = baseline[id];
      const price = entry.prices?.[id];
      return (!buyDate || entry.date >= buyDate) && Number.isFinite(startPrice) && Number.isFinite(price) && startPrice > 0
        ? amount * (price / startPrice)
        : null;
    });
    const total = values.reduce((sum, value) => sum + value, 0);
    return values.some((value) => value === null)
      ? []
      : [{ date: entry.date, value: Math.round(total * 100) / 100 }];
  });
}

export function calculateHoldings(portfolio, history, assets) {
  const baseline = getBaselinePrices(portfolio, history);
  return portfolio.map((item) => {
    const quote = assets[item.id] ?? {};
    const startPrice = baseline[item.id];
    const currentPrice = quote.price;
    const value = Number.isFinite(startPrice) && startPrice > 0 && Number.isFinite(currentPrice)
      ? item.amount * (currentPrice / startPrice)
      : null;
    const returnPct = value === null ? null : ((value - item.amount) / item.amount) * 100;
    return { ...item, ...quote, startPrice, value, returnPct };
  });
}

export function createAnalysisReport(history, portfolio, generatedAt = new Date().toISOString(), timeframeDays = 7) {
  const recent = filterHistoryByTimeframe(history, timeframeDays);
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
      amount: asset.amount,
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
  const totalAmount = changes.reduce((sum, asset) => sum + asset.amount, 0);
  const portfolioChangePct = totalAmount
    ? changes.reduce((sum, asset) => sum + asset.changePct * asset.amount, 0) / totalAmount
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
      : `The model portfolio moved ${portfolioChangePct >= 0 ? '+' : ''}${portfolioChangePct.toFixed(2)}% over a ${timeframeDays}-day trailing window (${recent.length} closes).`,
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

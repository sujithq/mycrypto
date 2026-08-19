export function isValidPortfolio(portfolio, supportedIds, target = 500) {
  if (!Array.isArray(portfolio) || portfolio.length !== 10) return false;
  const ids = portfolio.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !supportedIds.has(id))) return false;
  const amounts = portfolio.map(({ amount }) => Number(amount));
  return amounts.every((amount) => Number.isFinite(amount) && amount > 0)
    && Math.abs(amounts.reduce((sum, amount) => sum + amount, 0) - target) < 0.01;
}

export function getBaselinePrices(portfolio, history) {
  return Object.fromEntries(portfolio.map(({ id }) => {
    const first = history.find((entry) => Number.isFinite(entry.prices?.[id]));
    return [id, first?.prices[id] ?? null];
  }));
}

export function calculateSeries(portfolio, history) {
  const baseline = getBaselinePrices(portfolio, history);
  return history.flatMap((entry) => {
    const values = portfolio.map(({ id, amount }) => {
      const startPrice = baseline[id];
      const price = entry.prices?.[id];
      return Number.isFinite(startPrice) && Number.isFinite(price) && startPrice > 0
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

export function createAnalysisReport(history, portfolio, generatedAt = new Date().toISOString()) {
  const recent = history.slice(-8);
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
      observations: ['The report will become more reliable after seven daily closes.'],
    };
  }

  const start = recent[0];
  const end = recent.at(-1);
  const changes = portfolio.flatMap((asset) => {
    const startPrice = start.prices[asset.id];
    const endPrice = end.prices[asset.id];
    if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice) || startPrice <= 0) return [];
    return [{
      symbol: asset.symbol,
      amount: asset.amount,
      changePct: ((endPrice - startPrice) / startPrice) * 100,
    }];
  });
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
      : `The model portfolio moved ${portfolioChangePct >= 0 ? '+' : ''}${portfolioChangePct.toFixed(2)}% over ${recent.length - 1} daily closes.`,
    portfolioChangePct: portfolioChangePct === null ? null : Number(portfolioChangePct.toFixed(4)),
    bestPerformer: best ? { symbol: best.symbol, changePct: Number(best.changePct.toFixed(4)) } : null,
    worstPerformer: worst ? { symbol: worst.symbol, changePct: Number(worst.changePct.toFixed(4)) } : null,
    observations: [
      best ? `${best.symbol} led the portfolio at ${best.changePct >= 0 ? '+' : ''}${best.changePct.toFixed(2)}%.` : 'No leader could be calculated.',
      worst ? `${worst.symbol} was weakest at ${worst.changePct >= 0 ? '+' : ''}${worst.changePct.toFixed(2)}%.` : 'No laggard could be calculated.',
      recent.length < 8
        ? `This early report uses ${recent.length} closes; the target weekly window is eight.`
        : 'Performance is allocation-weighted and compares eight daily closes.',
      'Momentum is descriptive, not predictive; review concentration and downside before acting.',
    ],
  };
}

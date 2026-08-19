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
    return values.some((value) => value === null)
      ? []
      : [{ date: entry.date, value: values.reduce((sum, value) => sum + value, 0) }];
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

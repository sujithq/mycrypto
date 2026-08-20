export const LIVE_MARKET_INTERVALS = [1, 5, 15, 30, 60];
export const DEFAULT_LIVE_MARKET_INTERVAL = 5;

export function normalizeLiveMarketSettings(value) {
  const intervalMinutes = Number(value?.intervalMinutes);
  return {
    enabled: value?.enabled === true,
    intervalMinutes: LIVE_MARKET_INTERVALS.includes(intervalMinutes)
      ? intervalMinutes
      : DEFAULT_LIVE_MARKET_INTERVAL,
  };
}

export function createLiveMarketSnapshot(quotes, ids, currency, updatedAt = new Date().toISOString()) {
  const byId = new Map(Array.isArray(quotes) ? quotes.map((quote) => [quote.id, quote]) : []);
  if (byId.size !== ids.length || ids.some((id) => !Number.isFinite(byId.get(id)?.current_price))) {
    throw new Error('CoinGecko returned incomplete live market quotes.');
  }

  return {
    updatedAt,
    currency,
    assets: Object.fromEntries(ids.map((id) => {
      const quote = byId.get(id);
      return [id, {
        price: quote.current_price,
        change24hPct: quote.price_change_percentage_24h,
        marketCap: quote.market_cap,
        rank: quote.market_cap_rank,
        image: quote.image,
      }];
    })),
  };
}

export function canUseLiveMarketSnapshot(snapshot, publishedMarket, ids) {
  const snapshotTime = Date.parse(snapshot?.updatedAt);
  const publishedTime = Date.parse(publishedMarket?.updatedAt);
  return Number.isFinite(snapshotTime)
    && snapshotTime > publishedTime
    && snapshot?.currency === publishedMarket?.currency
    && ids.every((id) => Number.isFinite(snapshot?.assets?.[id]?.price));
}

export function isLiveMarketRefreshDue(snapshot, intervalMinutes, timestamp = Date.now()) {
  const updatedAt = Date.parse(snapshot?.updatedAt);
  const interval = normalizeLiveMarketSettings({ intervalMinutes }).intervalMinutes;
  const age = timestamp - updatedAt;
  return !Number.isFinite(updatedAt) || age < 0 || age >= interval * 60_000;
}

export function mergeLiveMarketSnapshot(publishedMarket, snapshot) {
  const date = snapshot.updatedAt.slice(0, 10);
  const current = {
    date,
    prices: Object.fromEntries(Object.entries(snapshot.assets).map(([id, asset]) => [id, asset.price])),
  };
  const history = [...publishedMarket.history.filter((entry) => entry.date !== date), current]
    .sort((left, right) => left.date.localeCompare(right.date));
  return {
    ...publishedMarket,
    updatedAt: snapshot.updatedAt,
    assets: { ...publishedMarket.assets, ...snapshot.assets },
    history,
  };
}
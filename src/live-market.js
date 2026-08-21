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

export function createIntradayMarketSnapshot(data, assetId, currency, updatedAt = new Date().toISOString()) {
  const byTimestamp = new Map();
  for (const point of Array.isArray(data?.prices) ? data.prices : []) {
    const timestamp = Number(point?.[0]);
    const price = Number(point?.[1]);
    if (Number.isFinite(timestamp) && timestamp > 0 && Number.isFinite(price) && price > 0) {
      byTimestamp.set(timestamp, price);
    }
  }
  const prices = [...byTimestamp]
    .sort(([left], [right]) => left - right)
    .map(([timestamp, price]) => ({ timestamp, price }));
  if (!assetId || !currency || !Number.isFinite(Date.parse(updatedAt)) || prices.length < 2) {
    throw new Error('CoinGecko returned incomplete intraday market data.');
  }
  return { assetId, currency, updatedAt, prices };
}

export function canUseIntradayMarketSnapshot(snapshot, assetId, currency) {
  return snapshot?.assetId === assetId
    && snapshot?.currency === currency
    && Number.isFinite(Date.parse(snapshot?.updatedAt))
    && Array.isArray(snapshot?.prices)
    && snapshot.prices.length > 1
    && snapshot.prices.every((point, index, prices) => Number.isFinite(point?.timestamp)
      && point.timestamp > 0
      && Number.isFinite(point.price)
      && point.price > 0
      && (index === 0 || point.timestamp > prices[index - 1]?.timestamp));
}

export function calculateIntradayAssetSeries(snapshot, holding) {
  const quantity = Number(holding?.quantity);
  const investedAmount = Number(holding?.investedAmount);
  const startPrice = Number(holding?.startPrice);
  const units = Number.isFinite(quantity) && quantity > 0
    ? quantity
    : investedAmount / startPrice;
  if (!Number.isFinite(units) || units <= 0) return [];
  return snapshot.prices.flatMap(({ timestamp, price }) => (
    holding?.buyDate && new Date(timestamp).toISOString().slice(0, 10) < holding.buyDate
      ? []
      : [{ timestamp, value: Math.round(units * price * 100) / 100 }]
  ));
}

export function calculateIntradayPriceSeries(snapshot, holding) {
  return snapshot.prices.flatMap(({ timestamp, price }) => (
    holding?.buyDate && new Date(timestamp).toISOString().slice(0, 10) < holding.buyDate
      ? []
      : [{ timestamp, value: price }]
  ));
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
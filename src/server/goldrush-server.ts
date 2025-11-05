import 'dotenv/config';
import express from 'express';
import path from 'path';
import { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// Ensure graphql-ws sees a WebSocket in Node
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).WebSocket = WebSocket;

import {
  GoldRushClient,
  StreamingChain,
  StreamingInterval,
  StreamingTimeframe,
} from '@covalenthq/client-sdk';

const DEFAULT_PORT = Number(process.env.GOLDRUSH_PORT || 4100);

function nowSeconds(): number { return Math.floor(Date.now() / 1000); }

const goldrushApiKey = process.env.GOLDRUSH_API_KEY || '';

function resolveChainEnum(chain?: string | null) {
  const c = (chain || '').toUpperCase();
  if ((StreamingChain as any)[c]) return (StreamingChain as any)[c];
  if (c === 'HYPERCORE') return (StreamingChain as any).HYPERCORE_MAINNET ?? StreamingChain.BASE_MAINNET;
  if (c === 'BASE') return StreamingChain.BASE_MAINNET;
  if (c === 'BSC') return StreamingChain.BSC_MAINNET;
  if (c === 'SOLANA') return (StreamingChain as any).SOLANA_MAINNET ?? StreamingChain.BASE_MAINNET;
  return StreamingChain.BASE_MAINNET;
}

function sanitizeAddress(input?: string | null): string | undefined {
  const raw = String(input ?? '');
  const parts = raw.split(':');
  const first = (parts[0] ?? '');
  const base = first.trim();
  if (!base) return undefined;
  if (base.startsWith('0x')) return base.toLowerCase();
  return base;
}

const defaultChainEnv = (process.env.GOLDRUSH_CHAIN || process.env.DEFAULT_CHAIN || 'BASE_MAINNET').toUpperCase();
const defaultIntervalEnv = (process.env.GOLDRUSH_INTERVAL || 'ONE_MINUTE').toUpperCase();
const defaultTimeframeEnv = (process.env.GOLDRUSH_TIMEFRAME || 'ONE_HOUR').toUpperCase();
const defaultToken = sanitizeAddress(process.env.GOLDRUSH_TOKEN || process.env.DEFAULT_TOKEN || process.env.GOLDRUSH_SYMBOL || process.env.CODEX_SYMBOL?.split(':')[0] || '0x4B6104755AfB5Da4581B81C552DA3A25608c73B8');
const defaultPair = sanitizeAddress(process.env.DEFAULT_PAIR || process.env.GOLDRUSH_PAIR);

export type GoldRushConnectionHandler = (ws: WebSocket, req: IncomingMessage) => void | Promise<void>;

export function createGoldRushConnectionHandler(): GoldRushConnectionHandler {
  return async (ws: WebSocket, req: IncomingMessage) => {
    const reqUrl = req.url ?? '/';
    const url = new URL(reqUrl, 'http://localhost');
    const qToken = sanitizeAddress(url.searchParams.get('token')) || defaultToken;
    const qPair = sanitizeAddress(url.searchParams.get('pair')) || defaultPair;
    const qChain = (url.searchParams.get('chain') || defaultChainEnv).toUpperCase();

    const chainEnv = qChain.toUpperCase();
    const intervalEnv = defaultIntervalEnv;
    const timeframeEnv = defaultTimeframeEnv;
    const tokenAddress = qToken;
    const pairAddress = qPair;

    const chainName = resolveChainEnum(chainEnv);
    const interval = (StreamingInterval as any)[intervalEnv] ?? StreamingInterval.ONE_MINUTE;
    const timeframe = (StreamingTimeframe as any)[timeframeEnv] ?? StreamingTimeframe.ONE_HOUR;
    const isSolanaChain = /SOLANA/.test(chainEnv);

    const client = new GoldRushClient(
      goldrushApiKey,
      {},
      {
        onConnecting: () => console.log('GoldRush: connecting to streaming service...'),
        onOpened: () => console.log('GoldRush: connected to streaming service!'),
        onClosed: () => console.log('GoldRush: disconnected from streaming service'),
        onError: (error) => console.error('GoldRush: streaming error:', error),
      }
    );

    const to = nowSeconds();
    const from = to - 60 * 60;
    console.log('Client connected (GoldRush). Streaming OHLCV...', {
      chain: chainEnv,
      token: tokenAddress,
      pair: pairAddress,
      interval: intervalEnv,
      timeframe: timeframeEnv,
      from,
      to,
    });

    ws.send(JSON.stringify({ type: 'snapshot', candles: [] }));

    (async () => {
      function resolveRpcUrl(chain?: string | null): string | undefined {
        const c = (chain || '').toUpperCase();
        if (c === 'BSC' || c === 'BSC_MAINNET' || c === '56') return 'https://bsc-dataseed.binance.org';
        if (c === 'BASE' || c === 'BASE_MAINNET' || c === '8453') return 'https://mainnet.base.org';
        return undefined;
      }
      function decodeSymbolFromHex(hex?: string | null): string | undefined {
        if (!hex || typeof hex !== 'string' || !hex.startsWith('0x')) return undefined;
        const data = hex.slice(2);
        try {
          if (data.length >= 128) {
            const len = parseInt(data.slice(64, 128), 16);
            const strHex = data.slice(128, 128 + len * 2);
            const bytes = strHex.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || [];
            return Buffer.from(bytes).toString('utf8').replace(/\0+$/, '') || undefined;
          }
          const bytes = data.slice(0, 64).match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || [];
          return Buffer.from(bytes).toString('utf8').replace(/\0+$/, '') || undefined;
        } catch { return undefined; }
      }
      try {
        const rpc = resolveRpcUrl(chainEnv);
        if (!rpc) return;
        const body: any = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [ { to: tokenAddress, data: '0x95d89b41' }, 'latest' ] };
        const resp = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!resp.ok) return;
        const json: any = await resp.json();
        const result = (json && (json as any).result) as string | undefined;
        const sym = decodeSymbolFromHex(result);
        if (sym) ws.send(JSON.stringify({ type: 'meta', symbol: sym }));
      } catch {}
    })();

    let hasSnapshot = false;
    let lastSentTime = 0;
    let aggMinute: number | null = null;
    let aggOpen = 0, aggHigh = 0, aggLow = 0, aggClose = 0;
    let aggVol: number | null = null;

    const densifyOneMinuteSeries = (candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number | null }>) => {
      if (!candles.length) return candles;
      const byTime = new Map<number, { time: number; open: number; high: number; low: number; close: number; volume: number | null }>();
      for (const c of candles) byTime.set(c.time, c);
      const sortedTimes: number[] = candles.map(c => c.time).sort((a, b) => a - b);
      const start: number = sortedTimes[0] as number;
      const end: number = sortedTimes[sortedTimes.length - 1] as number;
      const result: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number | null }> = [];
      let prevClose: number = byTime.get(start)!.close;
      for (let t = start; t <= end; t += 60) {
        const c = byTime.get(t);
        if (c) {
          result.push(c);
          prevClose = c.close;
        } else {
          result.push({ time: t, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0 });
        }
      }
      return result;
    };

    const mapItems = (items: any[]) => {
      return items.map((item: any) => {
        const isoTs = item.timestamp as string | undefined;
        const secondsRaw = isoTs ? Math.floor(new Date(isoTs).getTime() / 1000) : undefined;
        const seconds = secondsRaw != null ? Math.floor(secondsRaw / 60) * 60 : undefined;
        const rateUsd = Number(item?.quote_rate_usd);
        const rateQ   = Number(item?.quote_rate);
        const factor  = (!isSolanaChain && isFinite(rateUsd) && isFinite(rateQ) && rateQ !== 0)
          ? (rateUsd / rateQ)
          : 1;
        const openRaw = Number(item?.open);
        const highRaw = Number(item?.high);
        const lowRaw  = Number(item?.low);
        const closeRaw= Number(item?.close);
        if (pairAddress) {
          const scale = (!isSolanaChain ? 1e8 : 1);
          const openUsd  = isSolanaChain ? openRaw  : (isFinite(openRaw)  ? (openRaw  * factor) / scale : openRaw);
          const highUsd  = isSolanaChain ? highRaw  : (isFinite(highRaw)  ? (highRaw  * factor) / scale : highRaw);
          const lowUsd   = isSolanaChain ? lowRaw   : (isFinite(lowRaw)   ? (lowRaw   * factor) / scale : lowRaw);
          const closeUsd = isSolanaChain ? closeRaw : (isFinite(closeRaw) ? (closeRaw * factor) / scale : closeRaw);
          return seconds ? {
            time: seconds,
            open: openUsd,
            high: highUsd,
            low: lowUsd,
            close: closeUsd,
            volume: item.volume_usd ?? null,
          } : null;
        } else {
          const openUsd  = isSolanaChain ? openRaw  : (isFinite(openRaw)  ? openRaw  * factor : openRaw);
          const highUsd  = isSolanaChain ? highRaw  : (isFinite(highRaw)  ? highRaw  * factor : highRaw);
          const lowUsd   = isSolanaChain ? lowRaw   : (isFinite(lowRaw)   ? lowRaw   * factor : lowRaw);
          const closeUsd = isSolanaChain ? closeRaw : (isFinite(closeRaw) ? closeRaw * factor : closeRaw);
          return seconds ? {
            time: seconds,
            open: openUsd,
            high: highUsd,
            low: lowUsd,
            close: closeUsd,
            volume: item.volume_usd ?? null,
          } : null;
        }
      }).filter(Boolean) as Array<{ time: number; open: number; high: number; low: number; close: number; volume: number | null }>;
    };

    const handleEvents = (mapped: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number | null }>) => {
      if (!hasSnapshot) {
        const sorted = densifyOneMinuteSeries(mapped.sort((a, b) => a.time - b.time));
        if (sorted.length) {
          const last = sorted[sorted.length - 1];
          if (last) lastSentTime = last.time;
          console.log(`GoldRush: sending initial snapshot with ${sorted.length} candles`);
          ws.send(JSON.stringify({ type: 'snapshot', candles: sorted }));
          hasSnapshot = true;
        }
        return;
      }

      const events = mapped.sort((a, b) => a.time - b.time);
      for (const e of events) {
        const t = e.time;
        if (t < lastSentTime) continue;
        if (aggMinute == null) {
          aggMinute = t;
          aggOpen = e.open; aggHigh = e.high; aggLow = e.low; aggClose = e.close; aggVol = (e.volume != null ? e.volume : null);
          lastSentTime = t;
          ws.send(JSON.stringify({ type: 'update', candle: { time: aggMinute, open: aggOpen, high: aggHigh, low: aggLow, close: aggClose, volume: aggVol } }));
          continue;
        }
        if (t === aggMinute) {
          aggHigh = Math.max(aggHigh, e.high);
          aggLow = Math.min(aggLow, e.low);
          aggClose = e.close;
          // volume_usd is an aggregated value for the candle; do not accumulate within the same minute
          if (e.volume != null) aggVol = e.volume; // overwrite with latest running total
          ws.send(JSON.stringify({ type: 'update', candle: { time: aggMinute, open: aggOpen, high: aggHigh, low: aggLow, close: aggClose, volume: aggVol } }));
        } else if (t > aggMinute) {
          const gap = Math.floor((t - aggMinute) / 60);
          if (gap > 1) {
            for (let i = 1; i < gap; i++) {
              const fillT = aggMinute + i * 60;
              const fillOpen = aggClose;
              const fillClose = aggClose;
              const fillHigh = aggClose;
              const fillLow = aggClose;
              const fillVol = 0;
              ws.send(JSON.stringify({ type: 'update', candle: { time: fillT, open: fillOpen, high: fillHigh, low: fillLow, close: fillClose, volume: fillVol } }));
              lastSentTime = fillT;
            }
          }
          aggMinute = t;
          aggOpen = e.open; aggHigh = e.high; aggLow = e.low; aggClose = e.close; aggVol = (e.volume != null ? e.volume : null);
          lastSentTime = t;
          ws.send(JSON.stringify({ type: 'update', candle: { time: aggMinute, open: aggOpen, high: aggHigh, low: aggLow, close: aggClose, volume: aggVol } }));
        }
      }
    };

    let unsubscribe: (() => void) | undefined;

    if (pairAddress) {
      unsubscribe = client.StreamingService.subscribeToOHLCVPairs(
        {
          chain_name: chainName,
          pair_addresses: [pairAddress!],
          interval,
          timeframe,
        },
        {
          next: (payload: any) => {
            const items: any[] = Array.isArray(payload)
              ? payload
              : (payload?.data?.ohlcvCandlesForPair ?? payload?.ohlcvCandlesForPair ?? []);
            if (!Array.isArray(items) || items.length === 0) return;
            const mapped = mapItems(items);
            handleEvents(mapped);
          },
          error: (err: any) => {
            console.error('GoldRush stream error:', err);
          },
          complete: () => {
            console.log('GoldRush stream completed');
          },
        }
      );
    } else {
      unsubscribe = client.StreamingService.subscribeToOHLCVTokens(
        {
          chain_name: chainName,
          token_addresses: [tokenAddress!],
          interval,
          timeframe,
        },
        {
          next: (payload: any) => {
            const items: any[] = Array.isArray(payload)
              ? payload
              : (payload?.data?.ohlcvCandlesForToken ?? payload?.ohlcvCandlesForToken ?? []);
            if (!Array.isArray(items) || items.length === 0) return;
            const mapped = mapItems(items);
            handleEvents(mapped);
          },
          error: (err: any) => {
            console.error('GoldRush stream error:', err);
          },
          complete: () => {
            console.log('GoldRush stream completed');
          },
        }
      );
    }

    ws.on('close', async () => {
      try { unsubscribe && unsubscribe(); } catch {}
      console.log('GoldRush client disconnected');
    });
  };
}

export function createGoldRushServer(port = DEFAULT_PORT) {
  const app = express();
  app.use(express.static(path.resolve(process.cwd(), 'public')));

  const server = app.listen(port, () => {
    console.log(`GoldRush server running at http://localhost:${port}/ohlcv-goldrush.html`);
  });

  const wss = new WebSocketServer({ server });
  const handler = createGoldRushConnectionHandler();
  wss.on('connection', handler);

  return { app, server, wss };
}

if (require.main === module) {
  createGoldRushServer();
}

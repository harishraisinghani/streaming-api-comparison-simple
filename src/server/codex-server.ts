import 'dotenv/config';
import express from 'express';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { sdk } from '../lib/codex-sdk';

const DEFAULT_PORT = Number(process.env.PORT || 4000);

function nowSeconds(): number { return Math.floor(Date.now() / 1000); }

function resolveNetworkIdStatic(chain?: string | null): number | undefined {
  const c = (chain || '').toUpperCase();
  if (c === 'BASE' || c === 'BASE_MAINNET') return 8453;
  if (c === 'BSC' || c === 'BSC_MAINNET') return 56;
  return undefined;
}

async function resolveNetworkIdDynamic(chain?: string | null): Promise<number | undefined> {
  const c = String(chain || '').toLowerCase();
  const staticId = resolveNetworkIdStatic(chain);
  if (typeof staticId === 'number') return staticId;
  try {
    const resp: any = await (sdk.queries as any).getNetworks();
    const list: any[] = resp?.getNetworks || resp?.networks || [];
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const match = list.find((n: any) => {
      const name = String(n?.name ?? '').toLowerCase();
      const slug = String(n?.slug ?? n?.key ?? '').toLowerCase();
      const ticker = String(n?.ticker ?? n?.symbol ?? '').toLowerCase();
      return name.includes(c) || slug === c || ticker === c || (c === 'sol' && (name.includes('solana') || slug.includes('solana') || ticker === 'sol'));
    });
    const idCandidate = match?.id ?? match?.networkId ?? match?.chainId;
    const idNum = typeof idCandidate === 'number' ? idCandidate : Number(idCandidate);
    return Number.isFinite(idNum) ? idNum : undefined;
  } catch (e) {
    console.error('resolveNetworkIdDynamic getNetworks failed:', e);
    return undefined;
  }
}

function resolveRpcUrl(chain?: string | null): string | undefined {
  const c = (chain || '').toUpperCase();
  if (c === 'BSC' || c === 'BSC_MAINNET' || c === '56') return 'https://bsc-dataseed.binance.org';
  if (c === 'BASE' || c === 'BASE_MAINNET' || c === '8453') return 'https://mainnet.base.org';
  if (c === 'SOLANA') return undefined;
  return undefined;
}

function decodeSymbolFromHex(hex?: string | null): string | undefined {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('0x')) return undefined;
  const data = hex.slice(2);
  try {
    if (data.length >= 128) {
      const lenHex = data.slice(64, 128);
      const len = parseInt(lenHex, 16);
      const strHex = data.slice(128, 128 + len * 2);
      const bytes = strHex.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || [];
      return Buffer.from(bytes).toString('utf8').replace(/\0+$/, '') || undefined;
    }
    const bytes = data.slice(0, 64).match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || [];
    return Buffer.from(bytes).toString('utf8').replace(/\0+$/, '') || undefined;
  } catch {
    return undefined;
  }
}

async function fetchTokenSymbol(chain: string | null | undefined, tokenAddress?: string | null): Promise<string | undefined> {
  const addr = (tokenAddress || '').toLowerCase();
  if (!addr) return undefined;
  const rpc = resolveRpcUrl(chain);
  if (!rpc) return undefined;
  try {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [
        { to: addr, data: '0x95d89b41' },
        'latest'
      ]
    } as any;
    const resp = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) return undefined;
    const json = await resp.json();
    const result = json?.result as string | undefined;
    return decodeSymbolFromHex(result);
  } catch {
    return undefined;
  }
}

function sanitizeAddress(input?: string | null, lowerCase = true): string | undefined {
  const raw = String(input ?? '');
  const parts = raw.split(':');
  const first = (parts[0] ?? '');
  const base = first.trim();
  if (!base) return undefined;
  return lowerCase ? base.toLowerCase() : base;
}

export type CodexConnectionHandler = (ws: WebSocket, req: IncomingMessage) => void | Promise<void>;

export function createCodexConnectionHandler(): CodexConnectionHandler {
  return async (ws: WebSocket, req: IncomingMessage) => {
    const reqUrl = req.url ?? '/';
    const url = new URL(reqUrl, 'http://localhost');
    const qTokenRaw = url.searchParams.get('token');
    const qPairRaw = url.searchParams.get('pair');
    const qChain = url.searchParams.get('chain');
    const isEvmChain = !!resolveRpcUrl(qChain);
    const qToken = sanitizeAddress(qTokenRaw, isEvmChain);
    const qPair = sanitizeAddress(qPairRaw, isEvmChain);

    let symbol = process.env.CODEX_SYMBOL || '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c:56';
    let usingPair = false;
    const nid = await resolveNetworkIdDynamic(qChain);
    if (qPair && typeof nid === 'number') {
      symbol = `${qPair}:${nid}`;
      usingPair = true;
    } else if (qToken && typeof nid === 'number') {
      symbol = `${qToken}:${nid}`;
    }

    const [tokenAddressRaw, networkIdStr] = symbol.split(':');
    const tokenAddress = tokenAddressRaw || undefined;
    const isNumericNetwork = !!(networkIdStr && /^\d+$/.test(networkIdStr));
    const networkIdAny: any = isNumericNetwork ? Number(networkIdStr) : (networkIdStr || undefined);
    const to = nowSeconds();
    const from = to - 60 * 60;

    console.log('Client connected. Fetching initial bars...', { symbol, from, to });
    console.log('Resolved params:', { qChain, qToken, qPair, usingPair, networkId: nid });

    let candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number | null }> = [];
    let initialPairId: string | null = null;

    try {
      if (!usingPair && tokenAddress && typeof networkIdAny === 'number') {
        try {
          console.log('Discovering pairs for token before snapshot...', { tokenAddress, networkId: networkIdAny });
          const pairs = await (sdk.queries as any).listPairsForToken({ tokenAddress, networkId: networkIdAny, limit: 10 });
          const firstPair = pairs?.listPairsForToken?.[0];
          if (firstPair?.address) {
            initialPairId = `${firstPair.address}:${networkIdAny}`;
            usingPair = true;
            console.log('Using discovered pair for snapshot/subscription', { initialPairId });
          }
        } catch (ePre) {
          console.warn('Pair discovery before snapshot failed; will continue', ePre);
        }
      }

      if (usingPair && typeof nid === 'number') {
        const pairIdForBars = initialPairId || symbol;
        console.log('Codex getBars pair request', { pairIdForBars });
        const pbars: any = await (sdk.queries as any).getBars({ symbol: pairIdForBars, from, to, resolution: '1', symbolType: 'POOL' as any });
        const pos = pbars.getBars?.o || [];
        candles = pos.map((o: any, idx: number) => {
          const open = Number(o ?? 0);
          const high = Number(pbars.getBars?.h?.[idx] ?? open);
          const low  = Number(pbars.getBars?.l?.[idx] ?? open);
          const close= Number(pbars.getBars?.c?.[idx] ?? open);
          const tv = (pbars.getBars?.t?.[idx] ?? 0);
          const vv = pbars.getBars?.volume?.[idx];
          const volume = vv != null ? Number(vv) : null;
          return { time: tv, open, high, low, close, volume };
        });
      } else {
        console.log('Codex getBars token request', { symbol, from, to, resolution: '1' });
        const bars = await (sdk.queries as any).getBars({ symbol, from, to, resolution: '1', symbolType: 'TOKEN' });
        const os = bars.getBars?.o || [];
        candles = os.map((o: any, idx: number) => {
          const open = Number(o ?? 0);
          const high = Number(bars.getBars?.h?.[idx] ?? open);
          const low  = Number(bars.getBars?.l?.[idx] ?? open);
          const close= Number(bars.getBars?.c?.[idx] ?? open);
          const tv = (bars.getBars?.t?.[idx] ?? 0);
          const vv = bars.getBars?.volume?.[idx];
          const volume = vv != null ? Number(vv) : null;
          return { time: tv, open, high, low, close, volume };
        });
      }
    } catch (e) {
      console.error('Initial getBars failed; proceeding with empty snapshot', e);
    }

    ws.send(JSON.stringify({ type: 'snapshot', candles }));

    let sentMeta = false;
    try {
      const staticEvm = resolveRpcUrl(qChain);
      if (staticEvm) {
        const sym = await fetchTokenSymbol(qChain, tokenAddress);
        if (sym) { ws.send(JSON.stringify({ type: 'meta', symbol: sym })); sentMeta = true; }
      } else {
        if (tokenAddress && networkIdAny != null) {
          try {
            const pairs = await (sdk.queries as any).listPairsForToken({ tokenAddress, networkId: networkIdAny, limit: 5 });
            const p = pairs?.listPairsForToken?.[0];
            const base = p?.baseToken || p?.token0;
            const quote = p?.quoteToken || p?.token1;
            let sym: string | undefined;
            if (base && (base.address || base.mint || '').toString().toLowerCase() === tokenAddress.toString().toLowerCase()) {
              sym = base.symbol || base.ticker || base.name;
            } else if (quote) {
              sym = quote.symbol || quote.ticker || quote.name;
            }
            if (sym) { ws.send(JSON.stringify({ type: 'meta', symbol: String(sym) })); sentMeta = true; }
          } catch {}
        }
      }
    } catch {}
    try {
      if (!sentMeta && tokenAddress) {
        const short = tokenAddress.length > 12 ? `${tokenAddress.slice(0,6)}…${tokenAddress.slice(-4)}` : tokenAddress;
        ws.send(JSON.stringify({ type: 'meta', symbol: short }));
      }
    } catch {}

    console.log('Starting subscription for realtime updates...');

    let hasUpdated = false;
    let cleanupCurrent: (() => void) | null = null;
    let aggMinute: number | null = null;
    let aggOpen = 0, aggHigh = 0, aggLow = 0, aggClose = 0;
    let aggVol: number | null = null;

    const handleNext = (msg: any) => {
      const usd = msg.data?.onTokenBarsUpdated?.aggregates?.r1?.usd || msg.data?.onBarsUpdated?.aggregates?.r1?.usd;
      if (!usd) return;
      hasUpdated = true;
      const minute = Math.floor(usd.t / 60) * 60;
      const event = { time: minute, open: usd.o, high: usd.h, low: usd.l, close: usd.c, volume: usd.volume };
      if (aggMinute == null) {
        aggMinute = minute;
        aggOpen = event.open; aggHigh = event.high; aggLow = event.low; aggClose = event.close; aggVol = event.volume ?? null;
        console.log('Stream update (usd r1):', event);
        ws.send(JSON.stringify({ type: 'update', candle: { time: aggMinute, open: aggOpen, high: aggHigh, low: aggLow, close: aggClose, volume: aggVol } }));
        return;
      }
      if (minute === aggMinute) {
        aggHigh = Math.max(aggHigh, event.high);
        aggLow = Math.min(aggLow, event.low);
        aggClose = event.close;
        if (aggVol != null && event.volume != null) aggVol += event.volume; else if (aggVol == null) aggVol = event.volume ?? null;
        ws.send(JSON.stringify({ type: 'update', candle: { time: aggMinute, open: aggOpen, high: aggHigh, low: aggLow, close: aggClose, volume: aggVol } }));
      } else if (minute > aggMinute) {
        aggMinute = minute;
        aggOpen = event.open; aggHigh = event.high; aggLow = event.low; aggClose = event.close; aggVol = event.volume ?? null;
        ws.send(JSON.stringify({ type: 'update', candle: { time: aggMinute, open: aggOpen, high: aggHigh, low: aggLow, close: aggClose, volume: aggVol } }));
      }
    };

    const handleError = (err: any) => {
      console.error('Subscription error:', err);
    };

    if (usingPair) {
      const pairId = initialPairId || symbol;
      console.log('Starting with pair-based subscription', { pairId });
      cleanupCurrent = (sdk.subscriptions as any).onBarsUpdated(
        { pairId } as any,
        { next: handleNext, error: handleError, complete: () => console.log('Pair stream completed') }
      );
    } else {
      const subVars: any = {};
      if (tokenAddress) subVars.tokenId = tokenAddress;
      if (networkIdAny != null) subVars.networkId = networkIdAny;
      cleanupCurrent = (sdk.subscriptions as any).onTokenBarsUpdated(
        subVars,
        { next: handleNext, error: handleError, complete: () => console.log('Token stream completed') }
      );
    }

    const fallbackTimer = usingPair ? null : setTimeout(async () => {
      if (hasUpdated) return;
      try {
        if (!tokenAddress || !networkIdAny) return;
        console.log('No token updates yet; falling back to pair-based stream...');
        const pairs = await (sdk.queries as any).listPairsForToken({
          tokenAddress,
          networkId: networkIdAny,
          limit: 10,
        });
        const firstPair = pairs.listPairsForToken?.[0];
        const pairAddress = firstPair?.address;
        if (!pairAddress) {
          console.warn('No pairs found for token; cannot subscribe by pair.');
          return;
        }
        if (cleanupCurrent) cleanupCurrent();
        const pairId = `${pairAddress}:${networkIdAny}`;
        console.log('Subscribing to pair-based bars', { pairId });
        cleanupCurrent = (sdk.subscriptions as any).onBarsUpdated(
          { pairId } as any,
          { next: handleNext, error: handleError, complete: () => console.log('Pair stream completed') }
        );
      } catch (e) {
        console.error('Fallback to pair-based stream failed:', e);
      }
    }, 8000);

    ws.on('close', () => {
      if (fallbackTimer) clearTimeout(fallbackTimer as any);
      if (cleanupCurrent) cleanupCurrent();
      console.log('Client disconnected, subscription cleaned up');
    });
  };
}

export function createCodexServer(port = DEFAULT_PORT) {
  const app = express();
  app.use(express.static(path.resolve(process.cwd(), 'public')));

  const server = app.listen(port, () => {
    console.log(`OHLCV server running at http://localhost:${port}/ohlcv.html`);
  });

  const wss = new WebSocketServer({ server });
  const handler = createCodexConnectionHandler();
  wss.on('connection', handler);

  return { app, server, wss };
}

if (require.main === module) {
  createCodexServer();
}

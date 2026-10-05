// Live presence: who else has this sheet open, where they're looking, what
// they have selected and where their pointer is. Ephemeral, so it doesn't go
// through the CRDT store: other tabs hear it over a BroadcastChannel and
// other machines through the sheet's presence relay (worker/index.ts).

import ReconnectingWebSocket from 'reconnecting-websocket';
import { PALETTE, getUser, newId } from './store.ts';
import { displayName, getMe, onMeChange } from './identity.ts';
import { getServerHttp, getSheet } from './sync.ts';

export interface Cursor {
  /** Fractional day under the pointer. */
  day: number;
  /** Person row the pointer is over, and the offset into that row. */
  user: string;
  dy: number;
}

export interface Peer {
  id: string;
  name: string;
  color: string;
  personId: string;
  /** Visible day range. */
  view: [number, number] | null;
  sel: string | null;
  cur: Cursor | null;
  at: number;
}

type Msg = ({ t: 'state' } & Peer) | { t: 'bye'; id: string } | { t: 'hello'; id: string };

const STALE_MS = 45_000;
const HEARTBEAT_MS = 15_000;
const SEND_MS = 70;

const self: Peer = { id: newId(), name: '', color: PALETTE[0], personId: '', view: null, sel: null, cur: null, at: 0 };
const peers = new Map<string, Peer>();
const listeners = new Set<() => void>();
let snapshot: Peer[] = [];
let channel: BroadcastChannel | null = null;
let socket: ReconnectingWebSocket | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastSent = 0;

const emit = () => {
  snapshot = [...peers.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  listeners.forEach((l) => l());
};

export const getPeers = () => snapshot;
export const onPeers = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const selfId = () => self.id;

const hashColor = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
};

const identify = () => {
  const me = getMe();
  const person = me.personId ? getUser(me.personId) : undefined;
  self.personId = person ? me.personId : '';
  self.name = displayName() || 'Guest';
  self.color = person?.color ?? hashColor(self.id);
};

const send = (msg: Msg) => {
  const s = JSON.stringify(msg);
  channel?.postMessage(s);
  if (socket?.readyState === WebSocket.OPEN) socket.send(s);
};
const flush = () => {
  timer = undefined;
  lastSent = Date.now();
  self.at = lastSent;
  send({ t: 'state', ...self });
};

/** Share part of my state (throttled). */
export const publish = (patch: Partial<Pick<Peer, 'view' | 'sel' | 'cur'>>) => {
  Object.assign(self, patch);
  if (timer) return;
  timer = setTimeout(flush, Math.max(0, SEND_MS - (Date.now() - lastSent)));
};

const receive = (raw: unknown) => {
  if (typeof raw !== 'string') return;
  let m: Msg;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (!m || typeof m.id !== 'string' || m.id === self.id) return;
  if (m.t === 'bye') {
    if (peers.delete(m.id)) emit();
  } else if (m.t === 'hello') {
    flush();
  } else if (m.t === 'state') {
    peers.set(m.id, { ...m, at: Date.now() });
    emit();
  }
};

export const startPresence = () => {
  if (channel) return;
  identify();
  onMeChange(() => {
    identify();
    flush();
  });
  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel(`prepweek-presence:${getSheet()}`);
    channel.onmessage = (e) => receive(e.data);
  }
  const http = getServerHttp();
  if (http) {
    socket = new ReconnectingWebSocket(`${http.replace(/^http/, 'ws')}/presence/${encodeURIComponent(getSheet())}`);
    socket.addEventListener('message', (e) => receive(e.data));
    socket.addEventListener('open', flush);
  }
  send({ t: 'hello', id: self.id });
  flush();
  setInterval(() => {
    flush();
    const now = Date.now();
    let changed = false;
    for (const [id, p] of peers) if (now - p.at > STALE_MS) changed = peers.delete(id) || changed;
    if (changed) emit();
  }, HEARTBEAT_MS);
  const bye = () => send({ t: 'bye', id: self.id });
  addEventListener('pagehide', bye);
  addEventListener('beforeunload', bye);
  addEventListener('pageshow', (e) => (e as PageTransitionEvent).persisted && flush());
  // Hidden tabs keep their place but drop the pointer.
  document.addEventListener('visibilitychange', () => document.hidden && publish({ cur: null }));
};

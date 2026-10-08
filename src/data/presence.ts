// Live presence: who else has this sheet open, where they're looking, what
// they have selected and where their pointer is. Ephemeral, so it doesn't go
// through the CRDT store: other tabs hear it over a BroadcastChannel and
// other machines through the sheet's presence relay (worker/index.ts).

import ReconnectingWebSocket from 'reconnecting-websocket';
import { PALETTE, getUser, newId } from './store.ts';
import { displayName, getMe, onMeChange } from './identity.ts';
import { getServerHttp, getSheet } from './sync.ts';
import { accessReady, getAccess, onAccess, withKey } from './access.ts';

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
/** Peers heard through the relay: while there are none, nothing goes to it. */
const remote = new Set<string>();
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

// Every message to the relay wakes its Durable Object, which is billed for
// the time it stays awake. Alone on a sheet (the usual case), the relay only
// needs my state when I connect, for the snapshot it gives newcomers; their
// hello asks for a fresh one.
const send = (msg: Msg, toRelay = remote.size > 0) => {
  const s = JSON.stringify(msg);
  channel?.postMessage(s);
  if (toRelay && socket?.readyState === WebSocket.OPEN) socket.send(s);
};
const flush = (toRelay?: boolean) => {
  timer = undefined;
  lastSent = Date.now();
  self.at = lastSent;
  send({ t: 'state', ...self }, toRelay);
};

/** Share part of my state (throttled). */
export const publish = (patch: Partial<Pick<Peer, 'view' | 'sel' | 'cur'>>) => {
  Object.assign(self, patch);
  if (timer) return;
  timer = setTimeout(flush, Math.max(0, SEND_MS - (Date.now() - lastSent)));
};

const receive = (raw: unknown, viaRelay = false) => {
  if (typeof raw !== 'string') return;
  let m: Msg;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (!m || typeof m.id !== 'string' || m.id === self.id) return;
  if (m.t === 'bye') {
    remote.delete(m.id);
    if (peers.delete(m.id)) emit();
  } else if (m.t === 'hello') {
    if (viaRelay) remote.add(m.id);
    flush();
  } else if (m.t === 'state') {
    if (viaRelay) remote.add(m.id);
    peers.set(m.id, { ...m, at: Date.now() });
    emit();
  }
};

export const startPresence = () => {
  if (channel) return;
  identify();
  onMeChange(() => {
    identify();
    flush(true);
  });
  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel(`prepweek-presence:${getSheet()}`);
    channel.onmessage = (e) => receive(e.data);
  }
  const http = getServerHttp();
  if (http) {
    // Opened once the access check allows it, closed while it doesn't (a
    // locked sheet isn't knocked on over and over).
    const ws = (socket = new ReconnectingWebSocket(() => withKey(`${http.replace(/^http/, 'ws')}/presence/${encodeURIComponent(getSheet())}`), [], { startClosed: true }));
    const follow = () => {
      if (getAccess()?.role === 'none') ws.close();
      else if (ws.readyState === ws.CLOSED) ws.reconnect();
    };
    void accessReady(http).then(() => {
      follow();
      onAccess(follow);
    });
    socket.addEventListener('message', (e) => receive(e.data, true));
    socket.addEventListener('open', () => {
      send({ t: 'hello', id: self.id }, true);
      flush(true);
    });
  }
  send({ t: 'hello', id: self.id });
  flush();
  setInterval(() => {
    flush();
    const now = Date.now();
    let changed = false;
    for (const [id, p] of peers) if (now - p.at > STALE_MS) changed = (remote.delete(id), peers.delete(id)) || changed;
    if (changed) emit();
  }, HEARTBEAT_MS);
  const bye = () => send({ t: 'bye', id: self.id }, true);
  addEventListener('pagehide', bye);
  addEventListener('beforeunload', bye);
  addEventListener('pageshow', (e) => (e as PageTransitionEvent).persisted && flush(true));
  // Hidden tabs keep their place but drop the pointer.
  document.addEventListener('visibilitychange', () => document.hidden && publish({ cur: null }));
};

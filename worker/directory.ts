// Accounts, workspaces and the sheet directory.
//
// One SQLite-backed Durable Object ("global") holds everything that spans
// sheets: people's accounts and sessions, workspaces and who belongs to them,
// invites, and which workspace each sheet belongs to. Sheet *content* stays in
// each sheet's own object (see SheetDurableObject). Nothing here is on the hot
// path of editing: it's consulted once per connection.
//
// Methods are called over RPC from the worker (worker/auth.ts), which has
// already resolved the caller's session; every method re-checks membership.

import { DurableObject } from 'cloudflare:workers';
import { DIGEST_HOUR, localTime, type DigestRecipient } from './digest.ts';
import { FREE_PEOPLE, appsumoPeople, paidPlan, type PlanInfo } from '../src/lib/plans.ts';
import type { Env } from './env.ts';

export type WorkspaceRole = 'admin' | 'member';

export interface User {
  id: string;
  email: string;
  name: string;
  avatar: string;
}

export interface SheetSummary {
  id: string;
  name: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: WorkspaceRole;
  sheets: SheetSummary[];
  plan: PlanInfo;
}

/** An AppSumo licence as a webhook or the licensing API reports it. */
export interface LicenseEvent {
  event: string;
  license_key: string;
  prev_license_key?: string;
  tier?: number;
  license_status?: string;
}

const DAY = 86_400_000;
const SESSION_MS = 60 * DAY;
const LOGIN_MS = 20 * 60_000;
const INVITE_MS = 14 * DAY;

const randomId = (bytes = 12) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

export const sha256 = async (s: string) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const nameFromEmail = (email: string) => {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
};

const TABLES: Record<string, string[]> = {
  users: ['id TEXT PRIMARY KEY', 'email TEXT UNIQUE NOT NULL', 'name TEXT NOT NULL', "avatar TEXT NOT NULL DEFAULT ''", 'created INTEGER NOT NULL'],
  sessions: ['hash TEXT PRIMARY KEY', 'user_id TEXT NOT NULL', 'expires INTEGER NOT NULL'],
  logins: ['hash TEXT PRIMARY KEY', 'email TEXT NOT NULL', 'next TEXT NOT NULL', 'expires INTEGER NOT NULL'],
  workspaces: ['id TEXT PRIMARY KEY', 'name TEXT NOT NULL', 'created INTEGER NOT NULL'],
  members: ['workspace_id TEXT NOT NULL', 'user_id TEXT NOT NULL', 'role TEXT NOT NULL', 'joined INTEGER NOT NULL', 'PRIMARY KEY (workspace_id, user_id)'],
  invites: ['token TEXT PRIMARY KEY', 'workspace_id TEXT NOT NULL', 'email TEXT NOT NULL', 'role TEXT NOT NULL', 'invited_by TEXT NOT NULL', 'created INTEGER NOT NULL', 'expires INTEGER NOT NULL'],
  sheets: ['id TEXT PRIMARY KEY', 'workspace_id TEXT NOT NULL', 'name TEXT NOT NULL', 'created INTEGER NOT NULL', 'created_by TEXT NOT NULL', 'deleted INTEGER NOT NULL DEFAULT 0'],
  // Daily digest settings; no row = on, in UTC, never sent.
  digests: [
    'user_id TEXT PRIMARY KEY',
    "tz TEXT NOT NULL DEFAULT ''",
    'off INTEGER NOT NULL DEFAULT 0',
    "token TEXT NOT NULL DEFAULT ''",
    "last_day TEXT NOT NULL DEFAULT ''",
    'last_at INTEGER NOT NULL DEFAULT 0',
    "origin TEXT NOT NULL DEFAULT ''",
  ],
  // Licences (AppSumo): which workspace each one upgrades, once redeemed.
  licenses: [
    'key TEXT PRIMARY KEY',
    "source TEXT NOT NULL DEFAULT 'appsumo'",
    'tier INTEGER NOT NULL DEFAULT 1',
    "status TEXT NOT NULL DEFAULT 'inactive'",
    "workspace_id TEXT NOT NULL DEFAULT ''",
    "user_id TEXT NOT NULL DEFAULT ''",
    'created INTEGER NOT NULL DEFAULT 0',
    'updated INTEGER NOT NULL DEFAULT 0',
  ],
  // Who is planned on each sheet (person keys, see lib/plans.ts), as each
  // sheet's object reports it: counted per workspace for its plan.
  // Paid plans (Paddle), one subscription per workspace. `updated` is when
  // the last notification applied happened (they can arrive out of order).
  subscriptions: [
    'workspace_id TEXT PRIMARY KEY',
    "customer TEXT NOT NULL DEFAULT ''",
    "subscription TEXT NOT NULL DEFAULT ''",
    "plan TEXT NOT NULL DEFAULT ''",
    "status TEXT NOT NULL DEFAULT ''",
    'period_end INTEGER NOT NULL DEFAULT 0',
    'updated INTEGER NOT NULL DEFAULT 0',
  ],
  // Paddle products and prices made on first use (see worker/billing.ts).
  paddle_ids: ['key TEXT PRIMARY KEY', "id TEXT NOT NULL DEFAULT ''"],
  sheet_people: ['sheet_id TEXT PRIMARY KEY', "people TEXT NOT NULL DEFAULT '[]'", 'updated INTEGER NOT NULL DEFAULT 0'],
};

export class DirectoryDurableObject extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const [table, columns] of Object.entries(TABLES)) {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (${columns.join(', ')})`);
      // CREATE TABLE IF NOT EXISTS leaves a table made by an earlier version as it is,
      // so add the columns it lacks. Added NOT NULL columns need a default.
      const have = new Set(this.sql.exec(`PRAGMA table_info(${table})`).toArray().map((c) => c.name));
      for (const def of columns) {
        const [name, type] = def.split(' ');
        if (name === 'PRIMARY' || have.has(name!)) continue;
        const fill = /NOT NULL/.test(def) && !/DEFAULT/.test(def) ? ` DEFAULT ${type === 'INTEGER' ? 0 : "''"}` : '';
        this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${def.replace(/ UNIQUE| PRIMARY KEY/g, '')}${fill}`);
      }
    }
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS members_by_user ON members (user_id);
      CREATE INDEX IF NOT EXISTS sheets_by_workspace ON sheets (workspace_id);
    `);
  }

  private one<T>(query: string, ...args: unknown[]): T | undefined {
    return this.sql.exec(query, ...args).toArray()[0] as T | undefined;
  }
  private all<T>(query: string, ...args: unknown[]): T[] {
    return this.sql.exec(query, ...args).toArray() as T[];
  }
  private role(userId: string, workspaceId: string): WorkspaceRole | null {
    return this.one<{ role: WorkspaceRole }>('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?', workspaceId, userId)?.role ?? null;
  }
  private requireRole(userId: string, workspaceId: string, need: WorkspaceRole) {
    const r = this.role(userId, workspaceId);
    if (!r || (need === 'admin' && r !== 'admin')) throw new Error(need === 'admin' ? 'Only admins can do that' : 'Not a member of this workspace');
  }

  // --- Sign-in -----------------------------------------------------------------

  /** A one-time magic-link token for `email`; null if one was asked for under a minute ago. */
  async createLogin(email: string, next: string): Promise<string | null> {
    // Each link is an email we pay for: don't let anyone send them in a loop.
    if (this.one('SELECT 1 FROM logins WHERE email = ? AND expires > ?', email.toLowerCase(), Date.now() + LOGIN_MS - 60_000)) return null;
    const token = randomId(24);
    this.sql.exec('DELETE FROM logins WHERE expires < ?', Date.now());
    this.sql.exec('INSERT INTO logins VALUES (?, ?, ?, ?)', await sha256(token), email.toLowerCase(), next, Date.now() + LOGIN_MS);
    return token;
  }

  async consumeLogin(token: string): Promise<{ email: string; next: string } | null> {
    const hash = await sha256(token);
    const row = this.one<{ email: string; next: string; expires: number }>('SELECT email, next, expires FROM logins WHERE hash = ?', hash);
    this.sql.exec('DELETE FROM logins WHERE hash = ?', hash);
    return row && row.expires > Date.now() ? { email: row.email, next: row.next } : null;
  }

  /** Find or create the account for a verified email; new accounts get a workspace. */
  async signIn(email: string, profile: { name?: string; avatar?: string } = {}): Promise<{ user: User; token: string; isNew: boolean }> {
    email = email.toLowerCase();
    let user = this.one<User>('SELECT id, email, name, avatar FROM users WHERE email = ?', email);
    const isNew = !user;
    if (!user) {
      user = { id: randomId(), email, name: profile.name || nameFromEmail(email), avatar: profile.avatar ?? '' };
      this.sql.exec('INSERT INTO users VALUES (?, ?, ?, ?, ?)', user.id, email, user.name, user.avatar, Date.now());
      const ws = randomId();
      this.sql.exec('INSERT INTO workspaces VALUES (?, ?, ?)', ws, `${user.name.split(' ')[0]}'s workspace`, Date.now());
      this.sql.exec('INSERT INTO members VALUES (?, ?, ?, ?)', ws, user.id, 'admin', Date.now());
    } else {
      // Google: keep the picture current, and replace a name that was only
      // guessed from the email address.
      if (profile.avatar && profile.avatar !== user.avatar) {
        this.sql.exec('UPDATE users SET avatar = ? WHERE id = ?', profile.avatar, user.id);
        user.avatar = profile.avatar;
      }
      if (profile.name && user.name === nameFromEmail(email) && profile.name !== user.name) {
        this.sql.exec('UPDATE users SET name = ? WHERE id = ?', profile.name, user.id);
        user.name = profile.name;
      }
    }
    const token = randomId(32);
    this.sql.exec('DELETE FROM sessions WHERE expires < ?', Date.now());
    this.sql.exec('INSERT INTO sessions VALUES (?, ?, ?)', await sha256(token), user.id, Date.now() + SESSION_MS);
    return { user, token, isNew };
  }

  async session(token: string): Promise<User | null> {
    if (!token) return null;
    const row = this.one<User & { expires: number }>(
      'SELECT u.id, u.email, u.name, u.avatar, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?',
      await sha256(token),
    );
    if (!row || row.expires < Date.now()) return null;
    return { id: row.id, email: row.email, name: row.name, avatar: row.avatar };
  }

  async signOut(token: string) {
    this.sql.exec('DELETE FROM sessions WHERE hash = ?', await sha256(token));
  }

  /**
   * Delete an account. Workspaces with nobody else in them go, with their
   * sheets (returned, to wipe). In shared ones the person just leaves; if
   * they were the last admin, the longest-standing member becomes one.
   * Their AppSumo licences come loose, so they can be applied again.
   */
  async deleteAccount(userId: string): Promise<{ sheets: string[]; workspaces: string[] }> {
    const sheets: string[] = [];
    const gone: string[] = [];
    const email = this.one<{ email: string }>('SELECT email FROM users WHERE id = ?', userId)?.email ?? '';
    for (const m of this.all<{ workspace_id: string; role: WorkspaceRole }>('SELECT workspace_id, role FROM members WHERE user_id = ?', userId)) {
      const others = this.all<{ user_id: string; role: WorkspaceRole }>(
        'SELECT user_id, role FROM members WHERE workspace_id = ? AND user_id != ? ORDER BY joined',
        m.workspace_id,
        userId,
      );
      if (!others.length) {
        sheets.push(...this.all<{ id: string }>('SELECT id FROM sheets WHERE workspace_id = ? AND deleted = 0', m.workspace_id).map((s) => s.id));
        this.sql.exec('UPDATE sheets SET deleted = 1 WHERE workspace_id = ?', m.workspace_id);
        this.sql.exec('DELETE FROM invites WHERE workspace_id = ?', m.workspace_id);
        this.sql.exec('DELETE FROM workspaces WHERE id = ?', m.workspace_id);
        gone.push(m.workspace_id);
      } else if (m.role === 'admin' && !others.some((o) => o.role === 'admin')) {
        this.sql.exec("UPDATE members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?", m.workspace_id, others[0]!.user_id);
      }
    }
    this.sql.exec('DELETE FROM members WHERE user_id = ?', userId);
    this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId);
    this.sql.exec('DELETE FROM digests WHERE user_id = ?', userId);
    this.sql.exec('DELETE FROM invites WHERE invited_by = ?', userId);
    if (email) this.sql.exec('DELETE FROM logins WHERE email = ?', email);
    for (const w of gone) this.sql.exec("UPDATE licenses SET workspace_id = '', user_id = '' WHERE workspace_id = ?", w);
    this.sql.exec("UPDATE licenses SET user_id = '' WHERE user_id = ?", userId);
    this.sql.exec('DELETE FROM users WHERE id = ?', userId);
    return { sheets, workspaces: gone };
  }

  /** Everything about one person, for "Export my data". */
  async accountExport(userId: string) {
    const user = this.one<User & { created: number }>('SELECT id, email, name, avatar, created FROM users WHERE id = ?', userId);
    return { user, workspaces: await this.workspaces(userId), digest: this.one('SELECT tz, off, last_day FROM digests WHERE user_id = ?', userId) ?? null };
  }

  async rename(userId: string, name: string) {
    if (name.trim()) this.sql.exec('UPDATE users SET name = ? WHERE id = ?', name.trim().slice(0, 80), userId);
  }

  // --- Workspaces --------------------------------------------------------------

  async workspaces(userId: string, enforced = false): Promise<WorkspaceSummary[]> {
    const ws = this.all<{ id: string; name: string; role: WorkspaceRole }>(
      'SELECT w.id, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.joined',
      userId,
    );
    return ws.map((w) => ({
      ...w,
      sheets: this.all<SheetSummary>('SELECT id, name FROM sheets WHERE workspace_id = ? AND deleted = 0 ORDER BY created', w.id),
      plan: this.plan(w.id, '', enforced),
    }));
  }

  async createWorkspace(userId: string, name: string): Promise<string> {
    const id = randomId();
    this.sql.exec('INSERT INTO workspaces VALUES (?, ?, ?)', id, name.trim().slice(0, 80) || 'New workspace', Date.now());
    this.sql.exec('INSERT INTO members VALUES (?, ?, ?, ?)', id, userId, 'admin', Date.now());
    return id;
  }

  async renameWorkspace(userId: string, workspaceId: string, name: string) {
    this.requireRole(userId, workspaceId, 'admin');
    if (name.trim()) this.sql.exec('UPDATE workspaces SET name = ? WHERE id = ?', name.trim().slice(0, 80), workspaceId);
  }

  /**
   * Delete a workspace (admins): its sheets are deleted too (they stay
   * claimed, so their addresses never open again), members and invites go.
   */
  async deleteWorkspace(userId: string, workspaceId: string): Promise<string[]> {
    this.requireRole(userId, workspaceId, 'admin');
    const sheets = this.all<{ id: string }>('SELECT id FROM sheets WHERE workspace_id = ? AND deleted = 0', workspaceId).map((s) => s.id);
    this.sql.exec('UPDATE sheets SET deleted = 1 WHERE workspace_id = ?', workspaceId);
    this.sql.exec('DELETE FROM invites WHERE workspace_id = ?', workspaceId);
    this.sql.exec('DELETE FROM members WHERE workspace_id = ?', workspaceId);
    this.sql.exec('DELETE FROM workspaces WHERE id = ?', workspaceId);
    return sheets;
  }

  async people(userId: string, workspaceId: string) {
    const me = this.role(userId, workspaceId);
    if (!me) throw new Error('Not a member of this workspace');
    const members = this.all<{ id: string; email: string; name: string; avatar: string; role: WorkspaceRole }>(
      'SELECT u.id, u.email, u.name, u.avatar, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.joined',
      workspaceId,
    );
    const invites =
      me === 'admin'
        ? this.all<{ token: string; email: string; role: WorkspaceRole; created: number }>(
            'SELECT token, email, role, created FROM invites WHERE workspace_id = ? AND expires > ? ORDER BY created',
            workspaceId,
            Date.now(),
          )
        : [];
    return { role: me, members, invites };
  }

  private admins(workspaceId: string) {
    return this.one<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND role = 'admin'", workspaceId)!.n;
  }

  async setRole(userId: string, workspaceId: string, targetId: string, role: WorkspaceRole) {
    this.requireRole(userId, workspaceId, 'admin');
    if (role !== 'admin' && this.role(targetId, workspaceId) === 'admin' && this.admins(workspaceId) <= 1)
      throw new Error('A workspace needs at least one admin');
    this.sql.exec('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?', role, workspaceId, targetId);
  }

  /** Remove someone (admins), or leave (anyone). Returns the workspace's sheets. */
  async removeMember(userId: string, workspaceId: string, targetId: string): Promise<string[]> {
    if (targetId !== userId) this.requireRole(userId, workspaceId, 'admin');
    if (this.role(targetId, workspaceId) === 'admin' && this.admins(workspaceId) <= 1) throw new Error('A workspace needs at least one admin');
    this.sql.exec('DELETE FROM members WHERE workspace_id = ? AND user_id = ?', workspaceId, targetId);
    return this.all<{ id: string }>('SELECT id FROM sheets WHERE workspace_id = ? AND deleted = 0', workspaceId).map((s) => s.id);
  }

  // --- Invites -----------------------------------------------------------------

  async invite(userId: string, workspaceId: string, email: string, role: WorkspaceRole): Promise<string> {
    this.requireRole(userId, workspaceId, 'admin');
    const token = randomId(18);
    this.sql.exec('DELETE FROM invites WHERE expires < ?', Date.now());
    this.sql.exec('INSERT INTO invites VALUES (?, ?, ?, ?, ?, ?, ?)', token, workspaceId, email.toLowerCase(), role, userId, Date.now(), Date.now() + INVITE_MS);
    return token;
  }

  async revokeInvite(userId: string, token: string) {
    const inv = this.one<{ workspace_id: string }>('SELECT workspace_id FROM invites WHERE token = ?', token);
    if (!inv) return;
    this.requireRole(userId, inv.workspace_id, 'admin');
    this.sql.exec('DELETE FROM invites WHERE token = ?', token);
  }

  async inviteInfo(token: string) {
    return (
      this.one<{ workspace: string; inviter: string; email: string }>(
        'SELECT w.name AS workspace, u.name AS inviter, i.email FROM invites i JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.invited_by WHERE i.token = ? AND i.expires > ?',
        token,
        Date.now(),
      ) ?? null
    );
  }

  /** Join the invite's workspace (anyone signed in who holds the link). */
  async acceptInvite(userId: string, token: string): Promise<string> {
    const inv = this.one<{ workspace_id: string; role: WorkspaceRole; expires: number }>('SELECT workspace_id, role, expires FROM invites WHERE token = ?', token);
    if (!inv || inv.expires < Date.now()) throw new Error('This invite has expired or was revoked');
    if (!this.role(userId, inv.workspace_id))
      this.sql.exec('INSERT INTO members VALUES (?, ?, ?, ?)', inv.workspace_id, userId, inv.role, Date.now());
    this.sql.exec('DELETE FROM invites WHERE token = ?', token);
    return inv.workspace_id;
  }

  // --- Sheets ------------------------------------------------------------------

  /** Who may do what on a sheet. `workspace: null` = not in any workspace. */
  async sheet(sheetId: string, userId: string | null, enforced = false) {
    const s = this.one<{ name: string; workspace_id: string; workspace: string | null; deleted: number }>(
      // LEFT JOIN: a deleted workspace's sheets must still read as claimed.
      'SELECT s.name, s.workspace_id, s.deleted, w.name AS workspace FROM sheets s LEFT JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?',
      sheetId,
    );
    if (!s) return { name: '', workspace: null, role: null, deleted: false };
    // A removed sheet stays claimed, so its URL never becomes open again.
    if (s.deleted) return { name: s.name, workspace: { id: s.workspace_id, name: s.workspace ?? '' }, role: null, deleted: true };
    return {
      name: s.name,
      workspace: { id: s.workspace_id, name: s.workspace ?? '' },
      role: userId ? this.role(userId, s.workspace_id) : null,
      deleted: false,
      plan: this.plan(s.workspace_id, sheetId, enforced),
    };
  }

  /**
   * Add a sheet to a workspace: a new one, or (with `id`) one that was
   * started without an account. A sheet already in a workspace can't be taken.
   */
  async addSheet(userId: string, workspaceId: string, name: string, id?: string): Promise<string> {
    this.requireRole(userId, workspaceId, 'member');
    const sheetId = id ?? randomId(9);
    if (this.one('SELECT id FROM sheets WHERE id = ?', sheetId)) throw new Error('That sheet already belongs to a workspace');
    this.sql.exec('INSERT INTO sheets (id, workspace_id, name, created, created_by) VALUES (?, ?, ?, ?, ?)', sheetId, workspaceId, name.trim().slice(0, 80) || 'Untitled sheet', Date.now(), userId);
    return sheetId;
  }

  async updateSheet(userId: string, sheetId: string, patch: { name?: string; workspaceId?: string }) {
    const s = this.one<{ workspace_id: string }>('SELECT workspace_id FROM sheets WHERE id = ?', sheetId);
    if (!s) throw new Error('Unknown sheet');
    this.requireRole(userId, s.workspace_id, 'member');
    if (patch.name?.trim()) this.sql.exec('UPDATE sheets SET name = ? WHERE id = ?', patch.name.trim().slice(0, 80), sheetId);
    if (patch.workspaceId && patch.workspaceId !== s.workspace_id) {
      this.requireRole(userId, s.workspace_id, 'admin');
      this.requireRole(userId, patch.workspaceId, 'member');
      this.sql.exec('UPDATE sheets SET workspace_id = ? WHERE id = ?', patch.workspaceId, sheetId);
    }
  }

  /** Delete a sheet (admins): nobody can open it any more. */
  async removeSheet(userId: string, sheetId: string): Promise<boolean> {
    const s = this.one<{ workspace_id: string }>('SELECT workspace_id FROM sheets WHERE id = ?', sheetId);
    if (!s) return false;
    this.requireRole(userId, s.workspace_id, 'admin');
    this.sql.exec('UPDATE sheets SET deleted = 1 WHERE id = ?', sheetId);
    return true;
  }

  // --- Daily digest ------------------------------------------------------------

  private digestRow(userId: string) {
    let row = this.one<{ tz: string; off: number; token: string }>('SELECT tz, off, token FROM digests WHERE user_id = ?', userId);
    if (!row) {
      row = { tz: '', off: 0, token: randomId(18) };
      this.sql.exec('INSERT INTO digests (user_id, token) VALUES (?, ?)', userId, row.token);
    }
    return row;
  }

  async digestSettings(userId: string) {
    const { tz, off } = this.digestRow(userId);
    return { on: !off, tz };
  }

  async setDigest(userId: string, patch: { on?: boolean; tz?: string; origin?: string }) {
    this.digestRow(userId);
    // Where links in the email point: the address this person uses the app at.
    if (patch.origin && /^https?:\/\/[^/]+$/.test(patch.origin)) this.sql.exec('UPDATE digests SET origin = ? WHERE user_id = ?', patch.origin, userId);
    if (typeof patch.on === 'boolean') this.sql.exec('UPDATE digests SET off = ? WHERE user_id = ?', patch.on ? 0 : 1, userId);
    if (typeof patch.tz === 'string' && patch.tz.length < 64) this.sql.exec('UPDATE digests SET tz = ? WHERE user_id = ?', patch.tz, userId);
    return this.digestSettings(userId);
  }

  /** The unsubscribe link in each digest: no sign-in needed. */
  async digestOffByToken(token: string): Promise<string | null> {
    const row = token ? this.one<{ user_id: string }>('SELECT user_id FROM digests WHERE token = ?', token) : undefined;
    if (!row) return null;
    this.sql.exec('UPDATE digests SET off = 1 WHERE user_id = ?', row.user_id);
    return this.one<{ email: string }>('SELECT email FROM users WHERE id = ?', row.user_id)?.email ?? '';
  }

  /**
   * Everyone whose workday morning it is (from DIGEST_HOUR, retried for a few
   * hours if sending failed) and who hasn't had today's digest yet.
   */
  async dueForDigest(now: number): Promise<DigestRecipient[]> {
    const users = this.all<{ id: string; email: string; name: string; tz: string | null; off: number | null; last_day: string | null; last_at: number | null; origin: string | null }>(
      'SELECT u.id, u.email, u.name, d.tz, d.off, d.last_day, d.last_at, d.origin FROM users u LEFT JOIN digests d ON d.user_id = u.id',
    );
    const out: DigestRecipient[] = [];
    for (const u of users) {
      if (u.off) continue;
      const t = localTime(now, u.tz ?? '');
      if (t.weekend || t.hour < DIGEST_HOUR || t.hour >= DIGEST_HOUR + 4 || u.last_day === t.date) continue;
      const sheets = this.all<{ id: string; name: string }>(
        'SELECT s.id, s.name FROM members m JOIN sheets s ON s.workspace_id = m.workspace_id WHERE m.user_id = ? AND s.deleted = 0 ORDER BY s.created',
        u.id,
      );
      // Links need an address; it is learned from the person's browser.
      if (!sheets.length || !(u.origin || this.env.APP_URL)) continue;
      const { token } = this.digestRow(u.id);
      out.push({ userId: u.id, email: u.email, name: u.name, token, date: t.date, day: t.day, since: u.last_at || now - DAY, origin: u.origin ?? '', sheets });
    }
    return out;
  }

  async markDigestSent(userId: string, date: string, at: number) {
    this.digestRow(userId);
    this.sql.exec('UPDATE digests SET last_day = ?, last_at = ? WHERE user_id = ?', date, at, userId);
  }

  // --- Plans and licences -------------------------------------------------------

  /** A sheet's object reports who is planned on it. */
  async setSheetPeople(sheetId: string, people: string[]) {
    const json = JSON.stringify([...new Set(people)].sort());
    const cur = this.one<{ people: string }>('SELECT people FROM sheet_people WHERE sheet_id = ?', sheetId);
    if (cur?.people === json) return;
    this.sql.exec('INSERT OR REPLACE INTO sheet_people VALUES (?, ?, ?)', sheetId, json, Date.now());
  }

  /**
   * A workspace's plan: the people its licences cover (a free allowance
   * without any), and the people on its sheets. `sheetId` asks how many of
   * them are on other sheets than that one.
   */
  private plan(workspaceId: string, sheetId: string, enforced: boolean): PlanInfo {
    const licenses = this.all<{ tier: number }>("SELECT tier FROM licenses WHERE workspace_id = ? AND status != 'deactivated'", workspaceId);
    const rows = this.all<{ sheet_id: string; people: string }>(
      'SELECT p.sheet_id, p.people FROM sheet_people p JOIN sheets s ON s.id = p.sheet_id WHERE s.workspace_id = ? AND s.deleted = 0',
      workspaceId,
    );
    const all = new Set<string>();
    const here = new Set<string>();
    for (const r of rows) for (const k of JSON.parse(r.people) as string[]) (r.sheet_id === sheetId ? here : all).add(k);
    const elsewhere = [...all].filter((k) => !here.has(k)).length;
    for (const k of here) all.add(k);
    const sub = this.one<{ plan: string; status: string; period_end: number }>('SELECT plan, status, period_end FROM subscriptions WHERE workspace_id = ?', workspaceId);
    // Past-due payments get Paddle's retries before the plan lapses.
    const paid = sub && ['active', 'trialing', 'past_due'].includes(sub.status) ? paidPlan(sub.plan) : undefined;
    const fromLicences = licenses.reduce((n, l) => n + appsumoPeople(l.tier), 0);
    const limit = (paid?.people ?? 0) + fromLicences || FREE_PEOPLE;
    const top = Math.max(0, ...licenses.map((l) => l.tier));
    const name = paid
      ? paid.name + (licenses.length ? ' + AppSumo' : '')
      : !licenses.length
        ? 'Free'
        : licenses.length === 1
          ? `AppSumo Tier ${top}`
          : `AppSumo (${licenses.length} licences)`;
    return { name, limit, used: all.size, elsewhere, enforced, paid: sub ? { plan: sub.plan, status: sub.status, until: sub.period_end } : null };
  }

  /**
   * For a sheet's object, checking people added on it: the limit, and who is
   * planned on the workspace's other sheets (they don't count twice).
   */
  async peopleRoom(sheetId: string) {
    const ws = this.one<{ workspace_id: string }>('SELECT workspace_id FROM sheets WHERE id = ? AND deleted = 0', sheetId)?.workspace_id;
    if (!ws) return { limit: FREE_PEOPLE, elsewhere: [] as string[] };
    const elsewhere = new Set<string>();
    const rows = this.all<{ people: string }>(
      'SELECT p.people FROM sheet_people p JOIN sheets s ON s.id = p.sheet_id WHERE s.workspace_id = ? AND s.deleted = 0 AND p.sheet_id != ?',
      ws,
      sheetId,
    );
    for (const r of rows) for (const k of JSON.parse(r.people) as string[]) elsewhere.add(k);
    return { limit: this.plan(ws, sheetId, true).limit, elsewhere: [...elsewhere] };
  }

  async workspacePlan(userId: string, workspaceId: string, enforced: boolean) {
    this.requireRole(userId, workspaceId, 'member');
    return this.plan(workspaceId, '', enforced);
  }

  /**
   * An AppSumo webhook (or what the licensing API said). Purchases and
   * activations add the licence; an upgrade or downgrade replaces the old
   * key with a new one, keeping its workspace; a deactivation (a refund)
   * stops it counting.
   */
  async licenseEvent(e: LicenseEvent) {
    const now = Date.now();
    const key = e.license_key;
    if (!key) return;
    const tier = Number(e.tier) || undefined;
    const status = e.event === 'deactivate' ? 'deactivated' : e.license_status || (e.event === 'purchase' ? 'inactive' : 'active');
    const prev = e.prev_license_key ? this.one<{ workspace_id: string; user_id: string; tier: number }>('SELECT workspace_id, user_id, tier FROM licenses WHERE key = ?', e.prev_license_key) : undefined;
    const cur = this.one<{ tier: number }>('SELECT tier FROM licenses WHERE key = ?', key);
    if (!cur)
      this.sql.exec(
        'INSERT INTO licenses (key, source, tier, status, workspace_id, user_id, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        key,
        'appsumo',
        tier ?? prev?.tier ?? 1,
        status,
        prev?.workspace_id ?? '',
        prev?.user_id ?? '',
        now,
        now,
      );
    else this.sql.exec('UPDATE licenses SET tier = ?, status = ?, updated = ? WHERE key = ?', tier ?? cur.tier, status, now, key);
    if (prev && e.prev_license_key !== key) {
      // The new key takes over the old one's workspace.
      if (prev.workspace_id) this.sql.exec("UPDATE licenses SET workspace_id = ?, user_id = ? WHERE key = ? AND workspace_id = ''", prev.workspace_id, prev.user_id, key);
      this.sql.exec("UPDATE licenses SET status = 'deactivated', updated = ? WHERE key = ?", now, e.prev_license_key);
    }
  }

  /** Apply a licence to a workspace (its admins). Moving it is allowed for whoever redeemed it. */
  async redeemLicense(userId: string, key: string, workspaceId: string, tier?: number) {
    this.requireRole(userId, workspaceId, 'admin');
    let l = this.one<{ workspace_id: string; user_id: string; status: string }>('SELECT workspace_id, user_id, status FROM licenses WHERE key = ?', key);
    if (!l) {
      // Redeemed before its webhook arrived: the licensing API vouched for it.
      await this.licenseEvent({ event: 'activate', license_key: key, tier, license_status: 'active' });
      l = { workspace_id: '', user_id: '', status: 'active' };
    }
    if (l.status === 'deactivated') throw new Error('This licence was refunded or replaced');
    if (l.workspace_id && l.workspace_id !== workspaceId && l.user_id !== userId) throw new Error('This licence is already used by another workspace');
    this.sql.exec("UPDATE licenses SET workspace_id = ?, user_id = ?, status = 'active', updated = ? WHERE key = ?", workspaceId, userId, Date.now(), key);
    if (tier) this.sql.exec('UPDATE licenses SET tier = ? WHERE key = ?', tier, key);
  }

  /** A licence's state, for the redeem page. */
  async license(key: string) {
    return this.one<{ key: string; tier: number; status: string; workspace_id: string; workspace: string | null }>(
      'SELECT l.key, l.tier, l.status, l.workspace_id, w.name AS workspace FROM licenses l LEFT JOIN workspaces w ON w.id = l.workspace_id WHERE l.key = ?',
      key,
    ) ?? null;
  }

  // --- Billing (Paddle) -----------------------------------------------------------

  /** The workspace's subscription, for its admins. */
  async billing(userId: string, workspaceId: string) {
    this.requireRole(userId, workspaceId, 'admin');
    return this.one<{ customer: string; subscription: string; plan: string; status: string }>(
      'SELECT customer, subscription, plan, status FROM subscriptions WHERE workspace_id = ?',
      workspaceId,
    ) ?? null;
  }

  /** What Paddle says about a workspace's subscription; `at` is when it
   *  happened (notifications), so an older one never undoes a newer one. */
  async setSubscription(workspaceId: string, s: { customer?: string; subscription?: string; plan?: string; status?: string; periodEnd?: number }, at = 0) {
    if (!workspaceId || !this.one('SELECT 1 FROM workspaces WHERE id = ?', workspaceId)) return;
    const row = this.one<{ updated: number }>('SELECT updated FROM subscriptions WHERE workspace_id = ?', workspaceId);
    if (!row) this.sql.exec('INSERT INTO subscriptions (workspace_id) VALUES (?)', workspaceId);
    else if (at && row.updated > at) return;
    for (const [col, v] of [['customer', s.customer], ['subscription', s.subscription], ['plan', s.plan], ['status', s.status], ['period_end', s.periodEnd]] as const)
      if (v !== undefined && v !== '' && v !== 0) this.sql.exec(`UPDATE subscriptions SET ${col} = ? WHERE workspace_id = ?`, v, workspaceId);
    if (at) this.sql.exec('UPDATE subscriptions SET updated = ? WHERE workspace_id = ?', at, workspaceId);
  }

  async paddleId(key: string) {
    return this.one<{ id: string }>('SELECT id FROM paddle_ids WHERE key = ?', key)?.id ?? '';
  }

  async setPaddleId(key: string, id: string) {
    this.sql.exec('INSERT OR REPLACE INTO paddle_ids (key, id) VALUES (?, ?)', key, id);
  }

  /** Workspace of a Paddle subscription (events that don't carry ours). */
  async workspaceOfSubscription(subscription: string) {
    return this.one<{ workspace_id: string }>('SELECT workspace_id FROM subscriptions WHERE subscription = ?', subscription)?.workspace_id ?? '';
  }

  /** Live subscriptions of these workspaces (to cancel when they're deleted). */
  async subscriptionsOf(workspaceIds: string[]) {
    return workspaceIds.flatMap((w) =>
      this.all<{ subscription: string }>("SELECT subscription FROM subscriptions WHERE workspace_id = ? AND subscription != '' AND status != 'canceled'", w).map(
        (r) => r.subscription,
      ),
    );
  }
}

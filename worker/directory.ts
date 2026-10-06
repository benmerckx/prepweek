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

export class DirectoryDurableObject extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS logins (hash TEXT PRIMARY KEY, email TEXT NOT NULL, next TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, joined INTEGER NOT NULL, PRIMARY KEY (workspace_id, user_id));
      CREATE TABLE IF NOT EXISTS invites (token TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, invited_by TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sheets (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, created_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
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

  /** A one-time magic-link token for `email`. */
  async createLogin(email: string, next: string): Promise<string> {
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

  async rename(userId: string, name: string) {
    if (name.trim()) this.sql.exec('UPDATE users SET name = ? WHERE id = ?', name.trim().slice(0, 80), userId);
  }

  // --- Workspaces --------------------------------------------------------------

  async workspaces(userId: string): Promise<WorkspaceSummary[]> {
    const ws = this.all<{ id: string; name: string; role: WorkspaceRole }>(
      'SELECT w.id, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.joined',
      userId,
    );
    return ws.map((w) => ({
      ...w,
      sheets: this.all<SheetSummary>('SELECT id, name FROM sheets WHERE workspace_id = ? AND deleted = 0 ORDER BY created', w.id),
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
  async deleteWorkspace(userId: string, workspaceId: string) {
    this.requireRole(userId, workspaceId, 'admin');
    this.sql.exec('UPDATE sheets SET deleted = 1 WHERE workspace_id = ?', workspaceId);
    this.sql.exec('DELETE FROM invites WHERE workspace_id = ?', workspaceId);
    this.sql.exec('DELETE FROM members WHERE workspace_id = ?', workspaceId);
    this.sql.exec('DELETE FROM workspaces WHERE id = ?', workspaceId);
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

  /** Remove someone (admins), or leave (anyone). */
  async removeMember(userId: string, workspaceId: string, targetId: string) {
    if (targetId !== userId) this.requireRole(userId, workspaceId, 'admin');
    if (this.role(targetId, workspaceId) === 'admin' && this.admins(workspaceId) <= 1) throw new Error('A workspace needs at least one admin');
    this.sql.exec('DELETE FROM members WHERE workspace_id = ? AND user_id = ?', workspaceId, targetId);
  }

  // --- Invites -----------------------------------------------------------------

  async invite(userId: string, workspaceId: string, email: string, role: WorkspaceRole): Promise<string> {
    this.requireRole(userId, workspaceId, 'admin');
    const token = randomId(18);
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
  async sheet(sheetId: string, userId: string | null) {
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
  async removeSheet(userId: string, sheetId: string) {
    const s = this.one<{ workspace_id: string }>('SELECT workspace_id FROM sheets WHERE id = ?', sheetId);
    if (!s) return;
    this.requireRole(userId, s.workspace_id, 'admin');
    this.sql.exec('UPDATE sheets SET deleted = 1 WHERE id = ?', sheetId);
  }
}

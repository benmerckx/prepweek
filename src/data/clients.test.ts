import { beforeEach, describe, expect, test } from 'bun:test';
import { clientIdFor, createProject, deleteClient, migrateClients, setProjectClient, store, updateClient } from './store.ts';

const projectsOf = (cid: string) => store.getRowIds('projects').filter((p) => store.getCell('projects', p, 'clientId') === cid);

describe('clients', () => {
  beforeEach(() => {
    store.delTable('projects');
    store.delTable('clients');
  });

  test('client text on projects becomes client rows, once', () => {
    store.setRow('projects', 'p1', { name: 'Website', client: 'Imec' });
    store.setRow('projects', 'p2', { name: 'App', client: ' imec ' });
    store.setRow('projects', 'p3', { name: 'Intern' });
    migrateClients();
    migrateClients();
    expect(store.getRowCount('clients')).toBe(1);
    const cid = store.getCell('projects', 'p1', 'clientId') as string;
    expect(store.getCell('clients', cid, 'name')).toBe('Imec');
    expect(projectsOf(cid).sort()).toEqual(['p1', 'p2']);
    expect(store.getCell('projects', 'p3', 'clientId')).toBe('');
  });

  test('two devices naming the same client agree on its id', () => {
    const a = clientIdFor('Yappa');
    expect(clientIdFor('yappa')).toBe(a);
  });

  test('set, rename and delete a client', () => {
    const p = createProject({ name: 'Care', client: 'Codeurs' });
    const cid = store.getCell('projects', p, 'clientId') as string;
    expect(store.getCell('clients', cid, 'name')).toBe('Codeurs');
    updateClient(cid, { name: 'Codeurs bv' }, 'Rename client');
    expect(store.getCell('projects', p, 'client')).toBe('Codeurs bv');
    // a renamed client keeps its id; a new client with the old name is new
    expect(clientIdFor('Codeurs')).not.toBe(cid);
    setProjectClient(p, 'Imec');
    expect(store.getCell('clients', store.getCell('projects', p, 'clientId') as string, 'name')).toBe('Imec');
    const imec = store.getCell('projects', p, 'clientId') as string;
    deleteClient(imec);
    expect(store.hasRow('clients', imec)).toBe(false);
    expect(store.getCell('projects', p, 'clientId')).toBe('');
    expect(store.hasRow('projects', p)).toBe(true);
  });
});

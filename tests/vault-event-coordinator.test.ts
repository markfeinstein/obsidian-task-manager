import assert from 'node:assert/strict';
import test from 'node:test';
import { VaultEventCoordinator } from '../src/vault-event-coordinator';

test('vault event coordinator installs one complete post-layout event set', () => {
  const listeners = new Map<string, (...args: never[]) => void>();
  const registered: unknown[] = [];
  const calls: string[] = [];
  const vault = {
    on: (name: string, callback: (...args: never[]) => void) => {
      listeners.set(name, callback);
      return { name };
    },
  };
  const coordinator = new VaultEventCoordinator(vault as never, (event) => { registered.push(event); }, {
    modify: () => { calls.push('modify'); },
    create: () => { calls.push('create'); },
    delete: () => { calls.push('delete'); },
    rename: (_file, oldPath) => { calls.push(`rename:${oldPath}`); },
  });
  assert.equal(listeners.size, 0, 'constructing before layout readiness performs no registration');
  assert.equal(coordinator.install(), true);
  assert.equal(coordinator.install(), false);
  assert.equal(registered.length, 4);
  listeners.get('modify')?.({} as never);
  listeners.get('create')?.({} as never);
  listeners.get('delete')?.({} as never);
  listeners.get('rename')?.({} as never, 'Old.md' as never);
  assert.deepEqual(calls, ['modify', 'create', 'delete', 'rename:Old.md']);
});

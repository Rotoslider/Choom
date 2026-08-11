import {
  choomHasSshPermission,
  normalizeChoomPermissions,
  serializeChoomPermissions,
} from '../lib/choom-permissions';

describe('Choom permissions', () => {
  it('defaults malformed or omitted permissions to no SSH access', () => {
    expect(normalizeChoomPermissions(undefined)).toEqual({ ssh: false });
    expect(normalizeChoomPermissions('{not json')).toEqual({ ssh: false });
    expect(normalizeChoomPermissions({ ssh: 'true' })).toEqual({ ssh: false });
  });

  it('recognizes a persisted SSH grant from Prisma or the API', () => {
    expect(choomHasSshPermission({ permissions: '{"ssh":true}' })).toBe(true);
    expect(choomHasSshPermission({ permissions: { ssh: true } })).toBe(true);
    expect(choomHasSshPermission({ permissions: '{"ssh":false}' })).toBe(false);
  });

  it('serializes only normalized grants', () => {
    expect(serializeChoomPermissions({ ssh: true })).toBe('{"ssh":true}');
    expect(serializeChoomPermissions({ ssh: 1 })).toBe('{"ssh":false}');
  });
});

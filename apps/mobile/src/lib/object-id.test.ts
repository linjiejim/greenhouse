import { describe, expect, it } from 'vitest';
import { compareIds, isObjectId, objectId } from './object-id';

describe('objectId', () => {
  it('accepts prefixed ULIDs and 1.x decimal strings', () => {
    expect(objectId('doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0')).toBe('doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0');
    expect(objectId('rec_01JB2Y8Z9QW3E4R5T6Y7V8H9P0')).toBe('rec_01JB2Y8Z9QW3E4R5T6Y7V8H9P0');
    expect(objectId('42')).toBe('42');
  });

  it('reads numbers saved before 3.0 as 1.x ids', () => {
    expect(objectId(42)).toBe('42');
    expect(objectId(0)).toBeNull();
    expect(objectId(1.5)).toBeNull();
  });

  it('rejects anything else', () => {
    for (const raw of ['', '0', '01', '-1', '1.5', '1e3', 'doc_01jb2y8z9qw3e4r5t6y7v8h9p0', 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9PI', 'document_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', null, undefined, {}]) {
      expect(objectId(raw), String(raw)).toBeNull();
    }
    expect(isObjectId(42)).toBe(false);
  });
});

describe('compareIds', () => {
  it('orders 1.x ids by value, then ULIDs by time', () => {
    const ids = ['tsk_01JB2Y8Z9QW3E4R5T6Y7V8H9P1', '10', 'tsk_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', '9'];
    expect([...ids].sort(compareIds)).toEqual(['9', '10', 'tsk_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', 'tsk_01JB2Y8Z9QW3E4R5T6Y7V8H9P1']);
  });
});

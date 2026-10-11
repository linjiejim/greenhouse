/**
 * The import wizard's mapping model (pure): one destination per file column,
 * built from the server's suggestions, checked before the dry run, and turned
 * into the request `previewImport` / `commitImport` take.
 */

import {
  isComputedFieldType,
  TABLE_IMPORT_CREATABLE_FIELD_TYPES,
  type TableImportColumn,
  type TableImportMapping,
} from '@greenhouse/types/tables';
import type { TableField } from '../../../lib/api/tables';

export type ImportCreatableType = (typeof TABLE_IMPORT_CREATABLE_FIELD_TYPES)[number];

export type ColumnDestination =
  | { kind: 'skip' }
  | { kind: 'field'; fieldId: number }
  | { kind: 'create'; name: string; type: ImportCreatableType };

export type MappingProblem =
  | { key: 'nothingMapped' }
  | { key: 'emptyName' }
  | { key: 'duplicateField'; name: string }
  | { key: 'duplicateName'; name: string };

function isCreatable(type: string): type is ImportCreatableType {
  return TABLE_IMPORT_CREATABLE_FIELD_TYPES.some((creatable) => creatable === type);
}

/** Fields a column may be imported into: stored and not attachments (the server also checks edit rights). */
export function importableFields(fields: readonly TableField[]): TableField[] {
  return fields.filter(
    (field) => !field.archived_at && !isComputedFieldType(field.type) && field.type !== 'attachment',
  );
}

/** The server's suggestion for each column, or skip. New fields are only offered when the caller can build. */
export function initialDestinations(columns: readonly TableImportColumn[], canBuild: boolean): ColumnDestination[] {
  return columns.map((column) => {
    const suggestion = column.suggestion;
    if (suggestion && 'fieldId' in suggestion) return { kind: 'field', fieldId: suggestion.fieldId };
    if (suggestion && canBuild && isCreatable(suggestion.create.type)) {
      return { kind: 'create', name: suggestion.create.name, type: suggestion.create.type };
    }
    return { kind: 'skip' };
  });
}

/** What a Select value means: `skip`, `create`, or `field:<id>`. */
export function destinationValue(destination: ColumnDestination): string {
  return destination.kind === 'field' ? `field:${destination.fieldId}` : destination.kind;
}

export function destinationFromValue(
  value: string,
  column: TableImportColumn,
  current: ColumnDestination,
): ColumnDestination {
  if (value.startsWith('field:')) return { kind: 'field', fieldId: Number(value.slice('field:'.length)) };
  if (value === 'create') {
    if (current.kind === 'create') return current;
    const type = isCreatable(column.inferredType) ? column.inferredType : 'text';
    return { kind: 'create', name: column.header.trim(), type };
  }
  return { kind: 'skip' };
}

export function mappingRequest(destinations: readonly ColumnDestination[]): TableImportMapping[] {
  return destinations.flatMap((destination, column): TableImportMapping[] => {
    if (destination.kind === 'field') return [{ column, fieldId: destination.fieldId }];
    if (destination.kind === 'create') {
      return [{ column, create: { name: destination.name.trim(), type: destination.type } }];
    }
    return [];
  });
}

export function mappedCount(destinations: readonly ColumnDestination[]): number {
  return destinations.filter((destination) => destination.kind !== 'skip').length;
}

/** What blocks the dry run, in the order the user should fix it. */
export function mappingProblems(
  destinations: readonly ColumnDestination[],
  fields: readonly TableField[],
): MappingProblem[] {
  const problems: MappingProblem[] = [];
  if (mappedCount(destinations) === 0) problems.push({ key: 'nothingMapped' });
  const seenFields = new Set<number>();
  const seenNames = new Set<string>();
  for (const destination of destinations) {
    if (destination.kind === 'field') {
      if (seenFields.has(destination.fieldId)) {
        const name = fields.find((field) => field.id === destination.fieldId)?.name ?? String(destination.fieldId);
        problems.push({ key: 'duplicateField', name });
      }
      seenFields.add(destination.fieldId);
    } else if (destination.kind === 'create') {
      const name = destination.name.trim();
      if (!name) {
        if (!problems.some((problem) => problem.key === 'emptyName')) problems.push({ key: 'emptyName' });
        continue;
      }
      if (seenNames.has(name.toLowerCase())) problems.push({ key: 'duplicateName', name });
      seenNames.add(name.toLowerCase());
    }
  }
  return problems;
}

/** A → Z, AA → … (spreadsheet column letters). */
export function columnLetter(index: number): string {
  let letters = '';
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

/** Without a header row, the first row is data: it leads the samples. */
export function columnSamples(column: TableImportColumn, hasHeader: boolean): string[] {
  return (hasHeader ? column.samples : [column.header, ...column.samples]).slice(0, 5);
}

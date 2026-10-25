/**
 * Extension compatibility declarations, shared by the API and web halves:
 * `sdk` (the extension contract revision an extension was written for) and
 * `core` (a semver range of Greenhouse versions).
 *
 * `EXTENSION_SDK` changes only when the contract itself breaks (a define field
 * or a kit symbol removed or changed in meaning). A mismatching `sdk` or a
 * `core` range the running version does not satisfy refuses activation; leaving
 * either out only warns in 3.x (both become required in 4.0).
 */
import { satisfiesRange } from './semver.js';

/** The extension contract revision this core implements. */
export const EXTENSION_SDK = 1;

export interface ExtensionCompatDeclaration {
  id: string;
  sdk?: number;
  core?: string;
}

/** Errors refuse activation; warnings are logged. */
export function checkExtensionCompat(
  ext: ExtensionCompatDeclaration,
  version: string | null,
  sdk = EXTENSION_SDK,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (ext.sdk === undefined) {
    warnings.push(`Extension "${ext.id}" does not declare \`sdk\` (this core is sdk ${sdk}); required from 4.0.`);
  } else if (ext.sdk !== sdk) {
    errors.push(
      `Extension "${ext.id}" was written for extension sdk ${ext.sdk}, but this core implements sdk ${sdk}. ` +
        'Update the extension to the current contract (see EXTENDING.md) before enabling it.',
    );
  }
  if (ext.core === undefined) {
    warnings.push(`Extension "${ext.id}" does not declare a \`core\` version range; required from 4.0.`);
  } else if (version === null) {
    warnings.push(`Extension "${ext.id}": the running Greenhouse version is unknown, \`core\` not checked.`);
  } else {
    let ok: boolean;
    try {
      ok = satisfiesRange(version, ext.core);
    } catch (error) {
      errors.push(`Extension "${ext.id}": ${error instanceof Error ? error.message : String(error)} in \`core\`.`);
      return { errors, warnings };
    }
    if (!ok) {
      errors.push(
        `Extension "${ext.id}" supports Greenhouse ${ext.core}, but this is ${version}. ` +
          'Use a matching extension release or switch the extension off.',
      );
    }
  }
  return { errors, warnings };
}

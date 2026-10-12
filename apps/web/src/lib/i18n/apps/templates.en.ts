export const appsTemplatesEn = {
  templates: {
    save: 'Save as a template',
    saveHint:
      'Export the saved draft and Base structure. Live records are never included. Automations and custom components require administrator review before installation.',
    key: 'Template key (use an existing key for a new version)',
    version: 'Version',
    newName: 'New application name (optional)',
    changelog: 'What changed (required for later versions)',
    samples: 'Handwritten sample records (optional)',
    samplesHint:
      'Enter up to 50 sample rows as JSON with tableId and values [{fieldId,value}]. Only scalar fields; no members, attachments, or linked records.',
    invalidSamples: 'Sample records must be a JSON array.',
    publish: 'Publish template version',
    details: 'Details and review',
    fields: '{count} fields',
    scan: 'Content scan',
    customUnavailable:
      'Custom HTML is stored for editing and review. Execution is currently unavailable, including after approval.',
    reviewContent: 'Inspect exact content and scan findings',
    note: 'Review note',
    approve: 'Approve this version',
    reject: 'Reject this version',
    archive: 'Archive template',
    archiveHint: 'This stops new installations. Apps already created from the template remain available.',
    status: {
      not_required: 'Ready to install',
      pending: 'Awaiting review',
      approved: 'Approved',
      rejected: 'Rejected',
    },
  },
} as const;

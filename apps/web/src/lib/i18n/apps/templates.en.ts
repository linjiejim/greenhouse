export const appsTemplatesEn = {
  templates: {
    save: 'Save as a template',
    saveHint:
      'Export the saved draft and Base structure. Live records are never included. Automations and custom components require administrator review before installation.',
    key: 'Template key (use an existing key for a new version)',
    version: 'Version',
    newName: 'App name (optional)',
    changelog: 'What changed (required for later versions)',
    samples: 'Handwritten sample records (optional)',
    samplesHint:
      'Enter up to 50 sample rows as JSON with tableId and values [{fieldId,value}]. Only scalar fields; no members, attachments, or linked records.',
    invalidSamples: 'Sample records must be a JSON array.',
    publish: 'Publish template version',
    details: 'View details',
    fields: '{count} fields',
    scan: 'Content scan',
    customUnavailable: 'Custom code cannot run yet, including after approval.',
    reviewContent: 'Source and scan results',
    technical: 'Version and technical details',
    management: 'Review and manage',
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

export const appsSandboxEn = {
  sandbox: {
    failed: 'Unable to complete the review',
    create: 'Create record',
    confirm: 'This component requests a change to {record}. Review the values before confirming.',
    executionUnavailable: 'Custom component execution is unavailable while browser isolation is being strengthened.',
    code: 'Component HTML',
    codeHint:
      'Inline HTML, CSS and JavaScript, up to 200 KB. Execution is currently disabled while stronger browser isolation is implemented.',
    bindings: 'Data bindings and actions',
    bindingsHint:
      'Edit the saved JSON. Bindings name tables in this Base; actions reference a records bindingId. Deletion is not supported. Every write asks the member to confirm.',
    invalidSettings:
      'Enter an object with bindings, optional actions and optional create. The server checks its schema on save.',
    disabled: 'Writing custom components is disabled for your account.',
    schema: 'Table and field identifiers',
    bridge: 'Component API',
    bridgeHint:
      'The saved bindings and actions are validated by the role-scoped gateway. The HTML bridge will become available when component execution is enabled.',
    pendingPublish:
      'Saved for administrator review. The current published app is unchanged. Publish again after approval.',
    reviews: 'Component reviews',
    reviewHint:
      'Review the exact version, source, bindings and actions. Approval allows its owner to publish it to other members; it does not activate the version.',
    emptyReviews: 'No component versions to review.',
    previous: 'Previously approved source (v{version})',
    note: 'Review note',
    approve: 'Approve this version',
    reject: 'Reject or revoke approval',
    status: {
      pending: 'Awaiting review',
      approved: 'Approved',
      rejected: 'Rejected',
      not_required: 'Review not required',
    },
  },
} as const;

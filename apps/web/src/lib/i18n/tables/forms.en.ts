/**
 * Tables · Forms: builder dialog and the submit page (`#/forms/:id`).
 * Owned by slice Fm; spread into `tables` by ./en.ts (keys resolve as `tables.<namespace>.*`).
 */

export const tablesFormsEn = {
  forms: {
    title: 'Forms',
    loadFailed: 'Unable to load forms',
    createFailed: 'Unable to create form',
    updateFailed: 'Unable to update form',
    internalName: 'Internal name',
    internalNamePlaceholder: 'e.g. Project intake',
    formTitle: 'Form title',
    formTitlePlaceholder: 'Shown to teammates',
    publishedFields: 'Published fields',
    createDraft: 'Create draft',
    newForm: 'New form',
    emptyTitle: 'No forms yet',
    emptyDescription: 'Create a form to collect structured records from internal teammates.',
    submit: 'Submit',
    responseRecorded: 'Your response has been recorded.',
    summary: '{count} fields · revision {revision}',
    unpublish: 'Unpublish',
    publish: 'Publish',
    copyLink: 'Copy internal form link',
    openForm: 'Open form',
    choose: 'Choose…',
    loadOneFailed: 'Unable to load form',
    submitFailed: 'Unable to submit form',
    unavailable: 'Form unavailable',
    notFound: 'This form was not found.',
    notPublished: 'Form is not published',
    notPublishedHint: 'Ask a Builder to publish this internal form.',
    responseRecordedTitle: 'Response recorded',
    submitAnother: 'Submit another response',
    internalForm: 'Internal form',
    submitting: 'Submitting…',
  },
} as const;

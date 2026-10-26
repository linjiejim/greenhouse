export default {
  title: 'Monthly retro',
  description: 'Generate a team review of usage, requests and spend.',
  generate: 'Generate this month’s retro',
  generating: 'Generating…',
  done: '{month} retro written to the knowledge base',
  open: 'Open {month} retro',
  failed: 'Could not generate the retro',
  skipped: {
    over_budget: '{month} retro written without suggestions: the team’s model budget is used up',
    no_model: '{month} retro written without suggestions: no model is configured',
    failed: '{month} retro written without suggestions: the model call failed',
  },
};

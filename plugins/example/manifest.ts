import pkg from './package.json';
/** Pure station metadata; code belongs in the API and web halves. */
export default {
  id: 'example',
  name: 'Example notes',
  description: 'Reference plugin: per-user notes with a tool, routes, a flag, a setting and a job.',
  version: pkg.version,
  sdk: 1,
  core: '>=3.0 <5',
  dependsOn: [],
  features: ['example'],
};

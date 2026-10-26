import pkg from './package.json';
export default {
  id: 'retro',
  name: 'Monthly retro',
  version: pkg.version,
  sdk: 1,
  core: '>=3.0.0 <5.0.0',
  dependsOn: ['knowledge'],
  features: [],
};

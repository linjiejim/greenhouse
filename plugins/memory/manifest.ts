import pkg from './package.json';
export default {
  id: 'memory',
  name: 'Memory',
  version: pkg.version,
  sdk: 1,
  core: '>=3.0 <5',
  dependsOn: [],
  features: ['memory'],
};

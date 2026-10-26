import pkg from './package.json';
export default {
  id: 'tables',
  name: 'Tables',
  description: 'Internal multidimensional tables, formulas and shared grid views.',
  sdk: 1,
  core: '>=3.0 <5',
  dependsOn: [],
  features: ['tables'],
  version: pkg.version,
};

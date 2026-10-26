import pkg from './package.json';
export default {
  id: 'email',
  name: 'Email',
  description: 'Email integration',
  version: pkg.version,
  sdk: 1,
  core: '>=3.0 <5',
  dependsOn: [],
  features: ['email'],
};

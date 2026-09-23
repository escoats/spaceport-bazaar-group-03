const { createProofOfConceptStrategy } = require('./proof-of-concept');

const { createFirstPassStrategy } = require('./first-pass');

const strategies = new Map([
  ['first-pass', createFirstPassStrategy],
  ['proof-of-concept', createProofOfConceptStrategy],
]);

function getStrategyNames() {
  return [...strategies.keys()];
}

function getStrategyFactory(name) {
  const factory = strategies.get(name);
  if (!factory) {
    throw new Error(
      `${name ? `Unknown strategy: ${name}.` : 'Missing --strategy.'} Available strategies: ${getStrategyNames().join(', ')}`,
    );
  }
  return factory;
}

module.exports = { getStrategyFactory, getStrategyNames };

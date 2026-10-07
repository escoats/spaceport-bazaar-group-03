const { createProofOfConceptStrategy } = require('./proof-of-concept');

const { createFirstPassStrategy } = require('./first-pass');
const { createGenerousStrategy } = require('./generous');
const { createGenerous2Strategy } = require('./generous-2');

const strategies = new Map([
  ['first-pass', createFirstPassStrategy],
  ['generous', createGenerousStrategy],
  ['generous-2', createGenerous2Strategy],
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

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getStrategyNames } = require('../../strategies');
const { createStrategyHarness } = require('../helpers/strategy-harness');

for (const name of getStrategyNames()) {
	test(`${name} satisfies the shared strategy contract`, () => {
		const { strategy, sent, deliverState, acknowledgeReadiness } = createStrategyHarness(name);

		for (const handler of ['onState', 'onReadiness', 'onResult', 'onProtocolError']) {
			assert.equal(typeof strategy[handler], 'function', `${name} must expose ${handler}`);
		}

		deliverState();

		assert.equal(sent.length, 1, `${name} must send one initial message`);
		assert.deepEqual(sent[0].ready, {
			type: 1,
			protocolVersion: '2.0',
			runId: 'run',
			ready: true,
			snapshotSequence: 1,
		});

		acknowledgeReadiness();
	});
}
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIncomingMessageHandler } = require('../../services/incoming-message-handlers');
const {
	createIncomingMessage,
	createMockStrategy,
	messagePayloads,
} = require('../helpers/fixtures');

for (const event of Object.keys(messagePayloads)) {
	test(`forwards ${event} messages to the matching strategy handler`, () => {
		const { strategy, calls } = createMockStrategy();
		const handleIncomingMessage = createIncomingMessageHandler(strategy);
		const payload = { ...messagePayloads[event] };

		const result = handleIncomingMessage(createIncomingMessage(event, payload));

		assert.equal(result, `${event}-handled`);
		assert.deepEqual(calls, [{ event, payload }]);
	});
}

test('rejects messages without a recognized event', () => {
	const { strategy, calls } = createMockStrategy();
	const handleIncomingMessage = createIncomingMessageHandler(strategy);

	assert.throws(
		() => handleIncomingMessage({ message: 'unknown', unknown: {} }),
		{ message: 'Received a server message without a recognized event' },
	);
	assert.deepEqual(calls, []);
});

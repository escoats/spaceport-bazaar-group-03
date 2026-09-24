const messagePayloads = Object.freeze({
	state: Object.freeze({ runId: 'run', snapshotSequence: 1 }),
	result: Object.freeze({ runId: 'run', requestId: 'request', ok: true }),
	protocolError: Object.freeze({ code: 'INVALID_MESSAGE', message: 'Invalid message' }),
	readiness: Object.freeze({ runId: 'run', ready: true, snapshotSequence: 1 }),
});

const clientMessages = Object.freeze({
	ready: Object.freeze({ ready: Object.freeze({
		type: 1,
		protocolVersion: '2.0',
		runId: 'run',
		ready: true,
		snapshotSequence: 1,
	}) }),
});

function createIncomingMessage(message, payload = messagePayloads[message]) {
	return { message, [message]: payload };
}

function createMockStrategy() {
	const calls = [];
	const strategy = {};

	for (const event of Object.keys(messagePayloads)) {
		strategy[`on${event[0].toUpperCase()}${event.slice(1)}`] = (payload) => {
			calls.push({ event, payload });
			return `${event}-handled`;
		};
	}

	return { strategy, calls };
}

function createMockSocket({ readyState, sendError = null, invokeCallback = false } = {}) {
	const sent = [];
	return {
		readyState,
		sent,
		send(data, options, callback) {
			sent.push({ data, options });
			if (invokeCallback) callback(sendError);
		},
	};
}

module.exports = {
	clientMessages,
	createIncomingMessage,
	createMockSocket,
	createMockStrategy,
	messagePayloads,
};

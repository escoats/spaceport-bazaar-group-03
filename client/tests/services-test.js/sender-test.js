const WebSocket = require('ws');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeClientMessage } = require('../../encoding');
const { createMessageSender } = require('../../services/outgoing-message-sender');
const {
	clientMessages,
	createMockSocket,
} = require('../helpers/fixtures');

test('does not send while the WebSocket is not open', () => {
	const socket = createMockSocket({ readyState: WebSocket.CLOSED });
	const sendMessage = createMessageSender(socket);

	assert.throws(
		() => sendMessage(clientMessages.ready),
		{ message: 'Cannot send a message while the WebSocket is not open' },
	);
	assert.deepEqual(socket.sent, []);
});

test('encodes and sends an outgoing message as binary', () => {
	const socket = createMockSocket({ readyState: WebSocket.OPEN });
	const sendMessage = createMessageSender(socket);

	sendMessage(clientMessages.ready);

	assert.deepEqual(socket.sent, [{
		data: encodeClientMessage(clientMessages.ready),
		options: { binary: true },
	}]);
});

test('reports send errors from the WebSocket callback', () => {
	const error = new Error('socket failure');
	const socket = createMockSocket({
		readyState: WebSocket.OPEN,
		sendError: error,
		invokeCallback: true,
	});
	const originalError = console.error;
	const errors = [];
	console.error = (...args) => errors.push(args);

	try {
		createMessageSender(socket)(clientMessages.ready);
	} finally {
		console.error = originalError;
	}

	assert.deepEqual(errors, [['Failed to send client message: socket failure']]);
});

const WebSocket = require('ws');
const { encodeClientMessage } = require('../encoding');
const { logMessage } = require('./message-logger');

function createMessageSender(socket) {
  return function sendMessage(message) {
    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error('Cannot send a message while the WebSocket is not open');
    }

    const data = encodeClientMessage(message);
    socket.send(data, { binary: true }, (error) => {
      if (error) {
        console.error(`Failed to send client message: ${error.message}`);
        return;
      }

      logMessage('outgoing', message);
    });
  };
}

module.exports = { createMessageSender };
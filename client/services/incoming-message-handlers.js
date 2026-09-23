function createIncomingMessageHandler(strategy) {
  return function handleIncomingMessage(message) {
    switch (message.message) {
      case 'state':
        return strategy.onState(message.state);
      case 'result':
        return strategy.onResult(message.result);
      case 'protocolError':
        return strategy.onProtocolError(message.protocolError);
      case 'readiness':
        return strategy.onReadiness(message.readiness);
      default:
        throw new Error('Received a server message without a recognized event');
    }
  };
}

module.exports = { createIncomingMessageHandler };

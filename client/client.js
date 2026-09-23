const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { parseArgs } = require('node:util');
const WebSocket = require('ws');
const { decodeServerMessage } = require('./encoding');
const { logMessage } = require('./services/message-logger');
const { createIncomingMessageHandler } = require('./services/incoming-message-handlers');
const { createMessageSender } = require('./services/outgoing-message-sender');
const { getStrategyFactory, getStrategyNames } = require('./strategies');

let createStrategy;
try {
  const { values } = parseArgs({
    options: {
      strategy: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(`Usage: npm start -- --strategy <name>\nAvailable strategies: ${getStrategyNames().join(', ')}`);
    process.exit(0);
  }
  createStrategy = getStrategyFactory(values.strategy);
} catch (error) {
  console.error(error.message);
  console.error('Usage: npm start -- --strategy <name>');
  process.exit(1);
}



// A full URL takes precedence and preserves an explicitly supplied wss:// scheme.
const endpoint = process.env.BAZAAR_WS_URL
  || `ws://${process.env.BAZAAR_HOST || '127.0.0.1'}:${process.env.BAZAAR_PORT || '3001'}/ws`;
const endpointUrl = new URL(endpoint);
if (!['ws:', 'wss:'].includes(endpointUrl.protocol)) {
  throw new Error('BAZAAR_WS_URL must use ws:// or wss://');
}

let accessToken = process.env.BAZAAR_ACCESS_TOKEN;
if (!accessToken) {
  const credentialsPath = path.resolve(__dirname, '../validation-credentials.json');
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const player = credentials.players.find(({ station_id }) => station_id === 'P01');

  if (!player || !player.token) {
    throw new Error('Set BAZAAR_ACCESS_TOKEN or provide credentials for station P01');
  }
  accessToken = player.token;
}

const requestedProtocol = 'bazaar.protobuf.v2';
const socket = new WebSocket(endpoint, requestedProtocol, {
  headers: {
    Authorization: `Bearer ${accessToken}`,
  },
});
const sendClientMessage = createMessageSender(socket);
const strategy = createStrategy({ sendClientMessage });
const handleIncomingMessage = createIncomingMessageHandler(strategy);

socket.on('open', () => {
  if (socket.protocol !== requestedProtocol) {
    socket.close();
    throw new Error(
      `Server selected unexpected WebSocket protocol: ${socket.protocol || '(none)'}`,
    );
  }

  console.log(`Connected to ${endpoint} with subprotocol ${socket.protocol}`);
});

socket.on('message', (data, isBinary) => {
  if (!isBinary) {
    console.error('Expected a binary protobuf message');
    return;
  }

  let message;
  try {
    message = decodeServerMessage(data);
  } catch (error) {
    console.error(`Failed to decode server message: ${error.message}`);
    return;
  }

  logMessage('incoming', message);

  try {
    handleIncomingMessage(message);
  } catch (error) {
    console.error(`Failed to handle incoming message: ${error.message}`);
  }
});

socket.on('error', (error) => {
  console.error(`WebSocket error: ${error.message}`);
});

socket.on('close', (code, reason) => {
  console.log(`Connection closed (${code})${reason.length ? `: ${reason}` : ''}`);
});

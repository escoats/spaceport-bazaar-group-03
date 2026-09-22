const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const credentialsPath = path.resolve(__dirname, '../validation-credentials.json');
const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
const player = credentials.players.find(({ station_id }) => station_id === 'P01');

if (!player) {
  throw new Error('No credentials found for station P01');
}

const endpoint = process.env.BAZAAR_WS_URL || 'ws://127.0.0.1:3001/ws';
const requestedProtocol = 'bazaar.protobuf.v2';
const socket = new WebSocket(endpoint, requestedProtocol, {
  headers: {
    Authorization: `Bearer ${player.token}`,
  },
});

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
  console.log(`Received ${isBinary ? 'binary' : 'text'} message (${data.length} bytes)`);
});

socket.on('error', (error) => {
  console.error(`WebSocket error: ${error.message}`);
});

socket.on('close', (code, reason) => {
  console.log(`Connection closed (${code})${reason.length ? `: ${reason}` : ''}`);
});
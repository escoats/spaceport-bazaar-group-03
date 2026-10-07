const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');

let values;
try {
  ({ values } = parseArgs({
    options: {
      count: { type: 'string', short: 'n', default: '3' },
      strategy: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  }));
} catch (error) {
  console.error(error.message);
  console.error('Usage: npm run start:many -- [--count <number>] --strategy <name>');
  process.exit(1);
}

if (values.help) {
  console.log('Usage: npm run start:many -- [--count <number>] --strategy <name>');
  console.log('Starts the requested number of clients using the credentials in ../.env.');
  process.exit(0);
}

const count = Number(values.count);
if (!Number.isInteger(count)) {
  console.error('Client count must be an integer.');
  process.exit(1);
}

const clientPath = path.join(__dirname, 'client.js');
const clientArguments = [];
if (values.strategy) {
  clientArguments.push('--strategy', values.strategy);
}

const clients = [];
let shuttingDown = false;

function stopClients(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Stopping clients (${signal})...`);
  for (const client of clients) {
    if (!client.killed) {
      client.kill(signal);
    }
  }
}

for (let index = 0; index < count; index += 1) {
  const clientNumber = index + 1;
  const client = spawn(process.execPath, [clientPath, ...clientArguments], {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit',
  });

  clients.push(client);
  client.on('error', (error) => {
    console.error(`Client ${clientNumber} failed to start: ${error.message}`);
  });
  client.on('exit', (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`Client ${clientNumber} exited with ${signal || `code ${code}`}.`);
    }
  });
}

process.on('SIGINT', () => stopClients('SIGINT'));
process.on('SIGTERM', () => stopClients('SIGTERM'));

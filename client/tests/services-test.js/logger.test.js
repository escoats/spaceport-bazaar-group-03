const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMessageLogger, summarizeMessage } = require('../../services/message-logger');

test('appends full messages and exact wire bytes within a run', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bazaar-logs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'nested', 'messages.jsonl');
  const lines = [];
  const options = { filePath, color: false, writeConsole: line => lines.push(line) };
  const message = { offer: { requestId: 'request\n1', body: {
    recipientId: 'P02', give: { water: 2, food: 0, components: 0 },
    receive: { water: 0, food: 1, components: 0 }, expiresTick: 6,
  } }, extra: { untouched: [false, 0, null, 'full detail'] } };
  const data = Buffer.from([0, 255, 3, 10]);
  const logger = createMessageLogger(options);
  logger('outgoing', message, { data });
  logger('incoming', null, { data, error: 'decode failed\nreason' });
  const files = fs.readdirSync(path.dirname(filePath));
  assert.equal(files.length, 2);
  const records = fs.readFileSync(path.join(path.dirname(filePath), files.find(file => file.endsWith('.jsonl'))), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].message, message);
  assert.equal(records[0].direction, 'outgoing');
  assert.ok(Number.isFinite(Date.parse(records[0].timestamp)));
  for (const record of records) assert.deepEqual(Buffer.from(record.wire.data, 'base64'), data);
  assert.equal(records[1].error, 'decode failed\nreason');
  assert.equal(records[1].direction, 'incoming');
  assert.match(lines[0], /^\[tick \?\] OFFER: to P02: give 2 water/);
  assert.match(lines[1], /^\[tick \?\] ERROR: invalid message/);
  assert.ok(lines.every(line => !/[\r\n]/.test(line)));
  assert.ok(!lines[0].includes('untouched'));
  const summary = fs.readFileSync(path.join(path.dirname(filePath), files.find(file => file.endsWith('-summary.log'))), 'utf8');
  assert.equal(summary, `${lines.join('\n')}\n`);
});

test('summarizes game commands and server events', () => {
  const cases = [
    [{ ready: { ready: false, snapshotSequence: 0 } }, /Set ready=false/],
    [{ readiness: { ready: true, snapshotSequence: 1 } }, /Readiness acknowledged/],
    [{ sync: {} }, /Request state sync/],
    [{ accept: { body: { offerId: 'offer-1' } } }, /Accept offer offer-1/],
    [{ withdraw: { body: { objectId: 'ad-1' } } }, /Withdraw ad-1/],
    [{ advertise: { body: { selling: { items: [1] }, seeking: { items: [] } } } }, /selling water; seeking nothing/],
    [{ result: { ok: false, code: 10, requestId: 'r1' } }, /rejected: insufficient resources \[r1\]/],
    [{ result: { ok: true, code: 1, transactionId: { value: 'tx1' } } }, /succeeded: OK; transaction tx1/],
    [{ protocolError: { code: 2, closeSession: false } }, /request capacity exceeded/],
    [{ message: 'state', state: { tick: 0, phase: 2, self: { stationId: 'P01', health: 10 } } }, /State running: P01, health 10/],
    [{ futureMessage: {} }, /Unrecognized message/],
  ];
  for (const [message, pattern] of cases) assert.match(summarizeMessage(message), pattern);
});


test('each run creates a separate timestamped file and preserves previous logs', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bazaar-runs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'custom.jsonl');
  fs.writeFileSync(filePath, 'previous log\n');
  const options = { filePath, writeConsole: () => {} };
  const first = createMessageLogger(options);
  const second = createMessageLogger(options);
  first('outgoing', { sync: { runId: 'first' } });
  second('outgoing', { sync: { runId: 'second' } });
  first('incoming', { readiness: { ready: true } });
  const files = fs.readdirSync(directory).filter(file => file !== 'custom.jsonl');
  assert.equal(files.length, 4);
  const messageFiles = files.filter(file => file.endsWith('.jsonl'));
  assert.equal(messageFiles.length, 2);
  for (const file of messageFiles) assert.ok(files.includes(file.replace(/\.jsonl$/, '-summary.log')));
  assert.ok(messageFiles.every(file => /^custom-\d{4}-\d{2}-\d{2}T.*\.jsonl$/.test(file)));
  const runs = messageFiles.map(file => fs.readFileSync(path.join(directory, file), 'utf8')
    .trim().split('\n').map(JSON.parse));
  assert.equal(runs.find(records => records[0].message.sync.runId === 'first').length, 2);
  assert.equal(runs.find(records => records[0].message.sync.runId === 'second').length, 1);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'previous log\n');
});

test('shows planets and trade direction once per activity, and resets for a new game', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bazaar-activity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lines = [];
  const logger = createMessageLogger({ filePath: path.join(directory, 'messages.jsonl'), color: false,
    writeConsole: line => lines.push(line) });
  const offer = { offerId: 'offer-1', proposerId: 'P01', recipientId: 'P02', status: 1,
    give: { water: 2, food: 0, components: 0 }, receive: { water: 0, food: 1, components: 0 } };
  const state = { runId: 'game-1', tick: 0, phase: 2,
    self: { stationId: 'P01', health: 10 },
    advertisements: { items: [{ advertisementId: 'ad-1', stationId: 'P02', status: 1,
      selling: { items: [2] }, seeking: { items: [1] } }] },
    offers: { items: [offer] }, transactions: { items: [] } };
  logger('incoming', { state });
  assert.ok(lines.includes('[tick 0] AD: P02 selling food; seeking water [ad-1]'));
  assert.ok(lines.includes('[tick 0] OFFER: P01 → P02: 2 water for 1 food [offer-1]'));
  lines.length = 0;
  logger('incoming', { state });
  assert.equal(lines.length, 1, 'unchanged snapshots only print the state summary');
  offer.status = 2;
  state.transactions.items.push({ ...offer, transactionId: 'tx-1', settledTick: 0 });
  lines.length = 0;
  logger('incoming', { state });
  assert.deepEqual(lines.slice(1), [
    '[tick 0] TRADE: P02 accepted offer offer-1; P01 traded 2 water for 1 food with P02',
  ]);
  lines.length = 0;
  logger('incoming', { state });
  assert.equal(lines.length, 1, 'historical transactions are not repeated');
  state.runId = 'game-2';
  lines.length = 0;
  logger('incoming', { state });
  assert.ok(lines.some(line => line.startsWith('[tick 0] AD:')));
  assert.ok(lines.some(line => line.startsWith('[tick 0] TRADE:')));
  const records = fs.readFileSync(path.join(directory, fs.readdirSync(directory).find(file => file.endsWith('.jsonl'))), 'utf8').trim().split('\n');
  assert.equal(records.length, 5, 'the file still contains exactly one complete record per message');
});

test('activity labels are bold and colored but planet and resource details are plain', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bazaar-style-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lines = [];
  const logger = createMessageLogger({ filePath: path.join(directory, 'messages.jsonl'), color: true,
    writeConsole: line => lines.push(line) });
  logger('incoming', { state: { runId: 'game', offers: { items: [{ offerId: 'gift', status: 1,
    proposerId: 'P03', recipientId: 'P01', give: { components: 1 }, receive: {} }] } } });
  assert.equal(lines[1], '[tick ?] \x1b[1;36mOFFER\x1b[0m: P03 → P01: 1 components for nothing [gift]');
  const summaryPath = path.join(directory, fs.readdirSync(directory).find(file => file.endsWith('-summary.log')));
  const summary = fs.readFileSync(summaryPath, 'utf8');
  assert.equal(summary, `${lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')}\n`);
  assert.ok(!summary.includes('\x1b'), 'summary files contain no terminal formatting');
});

test('uses snapshot ticks for commands, event ticks for results and trades, and resets for a new run', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bazaar-ticks-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lines = [];
  const logger = createMessageLogger({ filePath: path.join(directory, 'messages.jsonl'), color: false,
    writeConsole: line => lines.push(line) });
  logger('incoming', { state: { runId: 'a', tick: 7, transactions: { items: [{
    transactionId: 'tx', offerId: 'offer', proposerId: 'P01', recipientId: 'P02',
    give: { water: 2 }, receive: { food: 1 }, settledTick: 3,
  }] } } });
  assert.match(lines[0], /^\[tick 7\] STATE: /);
  assert.match(lines[1], /^\[tick 3\] TRADE: /);
  logger('outgoing', { sync: { runId: 'a' } });
  assert.equal(lines.at(-1), '[tick 7] SYNC: request state sync');
  logger('incoming', { result: { runId: 'a', processedTick: 8, ok: true, code: 1 } });
  assert.equal(lines.at(-1), '[tick 8] RESULT: command succeeded; OK');
  logger('outgoing', { ready: { runId: 'b', ready: true, snapshotSequence: 1 } });
  assert.equal(lines.at(-1), '[tick ?] READY: ready=true for snapshot 1');
  logger('incoming', { state: { runId: 'b', tick: 0 } });
  assert.match(lines.at(-1), /^\[tick 0\] STATE: /);
});


test('result logs identify commands by request ID, including failures and repeated results', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bazaar-results-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lines = [];
  const logger = createMessageLogger({ filePath: path.join(directory, 'messages.jsonl'), color: false,
    writeConsole: line => lines.push(line) });
  for (const kind of ['offer', 'advertise', 'accept', 'withdraw']) {
    logger('outgoing', { [kind]: { runId: 'a', requestId: kind, body: {} } });
  }
  for (const [kind, action] of [['withdraw', 'withdrawal'], ['accept', 'offer acceptance'],
    ['advertise', 'advertisement publication'], ['offer', 'offer creation']]) {
    for (const ok of [true, false, true]) {
      logger('incoming', { result: { runId: 'a', requestId: kind, ok, code: ok ? 1 : 10,
        processedTick: 4, objectId: { value: 'object-1' } } });
      assert.equal(lines.at(-1), `[tick 4] RESULT: ${action} ${ok ? 'succeeded; OK' : 'failed; insufficient resources'} [${kind}]; object object-1`);
    }
  }
  logger('incoming', { result: { runId: 'a', requestId: 'unknown', ok: false, code: 6 } });
  assert.match(lines.at(-1), /RESULT: command failed; not found/);
  logger('incoming', { result: { runId: 'b', requestId: 'offer', ok: true, code: 1 } });
  assert.match(lines.at(-1), /RESULT: command succeeded; OK/);
});

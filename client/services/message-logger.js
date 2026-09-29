const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const resources = { 1: 'water', 2: 'food', 3: 'components' };
const phases = { 1: 'ready', 2: 'running', 3: 'paused', 4: 'finished', 5: 'aborted' };
const resultCodes = ['', 'OK', 'request ID conflict', 'run not running', 'rate limited',
  'invalid argument', 'not found', 'expired', 'not open', 'limit reached',
  'insufficient resources', 'station failed'];
const controlCodes = ['', 'bad message', 'request capacity exceeded', 'unsupported version',
  'run mismatch', 'invalid authentication', 'session fenced'];
const kinds = ['state', 'result', 'protocolError', 'readiness', 'advertise', 'offer', 'accept', 'withdraw', 'sync', 'ready'];
const bundle = (value = {}) => ['water', 'food', 'components']
  .map(key => `${value[key] ?? 0} ${key}`).join(', ');
const resourceList = value => value?.items?.map(id => resources[id] || id).join(', ') || 'nothing';

function summarizeMessage(message) {
  const kind = message?.message || kinds.find(key => message?.[key]);
  const event = message?.[kind] || {};
  const body = event.body || {};
  const request = event.requestId ? ` [${event.requestId.value ?? event.requestId}]` : '';
  switch (kind) {
    case 'state':
      return `State ${phases[event.phase] || event.phase}: ${event.self?.stationId}, health ${event.self?.health}, inventory ${bundle(event.self?.inventory)}; ${event.offers?.items?.length ?? 0} offers, ${event.transactions?.items?.length ?? 0} transactions`;
    case 'offer':
      return `Offer to ${body.recipientId}: give ${tradeBundle(body.give)}; receive ${tradeBundle(body.receive)}; expires tick ${body.expiresTick}${request}`;
    case 'advertise':
      return `Advertise: selling ${resourceList(body.selling)}; seeking ${resourceList(body.seeking)}; expires tick ${body.expiresTick}${request}`;
    case 'accept': return `Accept offer ${body.offerId}${request}`;
    case 'withdraw': return `Withdraw ${body.objectId}${request}`;
    case 'sync': return 'Request state sync';
    case 'ready': return `Set ready=${event.ready} for snapshot ${event.snapshotSequence}`;
    case 'readiness': return `Readiness acknowledged: ready=${event.ready}, snapshot ${event.snapshotSequence}`;
    case 'result':
      return `Command ${event.ok ? 'succeeded' : 'rejected'}: ${resultCodes[event.code] || event.code}${request}${event.objectId?.value ? `; object ${event.objectId.value}` : ''}${event.transactionId?.value ? `; transaction ${event.transactionId.value}` : ''}`;
    case 'protocolError':
      return `Protocol error: ${controlCodes[event.code] || event.code}${event.requestId?.value ? ` [${event.requestId.value}]` : ''}; close session=${event.closeSession}`;
    default: return 'Unrecognized message';
  }
}

// State messages contain the public activity. Report newly observed entries and
// status changes once, rather than repeating the entire market every snapshot.
const tradeBundle = (value = {}) => Object.keys(resources).map(id => resources[id])
  .filter(key => value[key] > 0).map(key => `${value[key]} ${key}`).join(', ') || 'nothing';

function createActivitySummarizer() {
  let runId;
  const advertisements = new Set();
  const offers = new Map();
  const transactions = new Set();
  return state => {
    if (state.runId !== runId) {
      runId = state.runId;
      advertisements.clear();
      offers.clear();
      transactions.clear();
    }
    const events = [];
    for (const ad of state.advertisements?.items || []) {
      if (ad.status === 1 && !advertisements.has(ad.advertisementId)) {
        events.push({ label: 'Advertise', detail: `${ad.stationId} selling ${resourceList(ad.selling)}; seeking ${resourceList(ad.seeking)} [${ad.advertisementId}]` });
        advertisements.add(ad.advertisementId);
      }
    }
    const newTrades = (state.transactions?.items || [])
      .filter(trade => !transactions.has(trade.transactionId));
    const settledOffers = new Set(newTrades.map(trade => trade.offerId));
    for (const offer of state.offers?.items || []) {
      if (offers.get(offer.offerId) === offer.status) continue;
      offers.set(offer.offerId, offer.status);
      if (offer.status === 1) {
        events.push({ label: 'Offer', detail: `${offer.proposerId} → ${offer.recipientId}: ${tradeBundle(offer.give)} for ${tradeBundle(offer.receive)} [${offer.offerId}]` });
      } else if (offer.status === 2 && !settledOffers.has(offer.offerId)) {
        events.push({ label: 'Accepted', detail: `${offer.recipientId} accepted offer ${offer.offerId} from ${offer.proposerId}`, colorCode: 32 });
      } else if (offer.status !== 2) {
        const status = { 3: 'withdrawn', 4: 'expired', 5: 'ended with run' }[offer.status] || `status ${offer.status}`;
        events.push({ label: 'Offer closed', detail: `${offer.proposerId} → ${offer.recipientId}: offer ${offer.offerId} ${status}`, colorCode: 33 });
      }
    }
    for (const trade of newTrades) {
      transactions.add(trade.transactionId);
      events.push({ label: 'Traded', detail: `${trade.recipientId} accepted offer ${trade.offerId}; ${trade.proposerId} traded ${tradeBundle(trade.give)} for ${tradeBundle(trade.receive)} with ${trade.recipientId}`, tick: trade.settledTick, colorCode: 32 });
    }
    return events;
  };
}

function createMessageLogger({
  filePath = process.env.BAZAAR_LOG_FILE || path.resolve(__dirname, '../logs/messages.jsonl'),
  writeConsole = line => console.log(line),
  color = Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env),
} = {}) {
  const { dir, name, ext } = path.parse(filePath);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const runFilePath = path.join(dir, `${name}-${runId}${ext || '.jsonl'}`);
  const summaryFilePath = path.join(dir, `${name}-${runId}-summary.log`);
  let initialized = false;
  const summarizeActivity = createActivitySummarizer();
  let currentTick;
  let currentRunId;
  const commands = new Map();
  const commandActions = {
    offer: 'offer creation', advertise: 'advertisement publication',
    accept: 'offer acceptance', withdraw: 'withdrawal',
  };
  const labels = {
    State: 'STATE', Offer: 'OFFER', Advertise: 'AD', 'Accept offer': 'ACCEPT',
    Withdraw: 'WITHDRAW', 'Request state sync': 'SYNC', 'Set ready': 'READY',
    'Readiness acknowledged': 'READINESS', 'Command succeeded': 'RESULT',
    'Command rejected': 'RESULT', 'Protocol error': 'ERROR', 'Invalid message': 'ERROR',
    'Unrecognized message': 'UNKNOWN', Accepted: 'ACCEPT', 'Offer closed': 'OFFER', Traded: 'TRADE',
  };
  function writeLine(direction, label, detail, colorCode, tick = currentTick) {
    const clean = value => value.replace(/[\r\n\u2028\u2029\x00-\x1f\x7f-\x9f]/g, ' ');
    const type = labels[label] || label.toUpperCase();
    const styledLabel = color ? `\x1b[1;${colorCode}m${type}\x1b[0m` : type;
    const prefix = `[tick ${clean(String(tick ?? '?'))}]`;
    const plainDetail = clean(detail);
    fs.appendFileSync(summaryFilePath, `${prefix} ${type}: ${plainDetail}\n`, 'utf8');
    writeConsole(`${prefix} ${styledLabel}: ${plainDetail}`);
  }
  return function logMessage(direction, message, { data, isBinary = true, error } = {}) {
    const timestamp = new Date().toISOString();
    const record = { timestamp, direction, message };
    if (data !== undefined) {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      record.wire = { isBinary, encoding: 'base64', data: bytes.toString('base64') };
    }
    if (error) record.error = error;
    if (!initialized) {
      fs.mkdirSync(path.dirname(runFilePath), { recursive: true });
      initialized = true;
    }
    // Synchronous append preserves event order and flushes each record before exit.
    fs.appendFileSync(runFilePath, `${JSON.stringify(record)}\n`, 'utf8');
    const kind = message?.message || kinds.find(key => message?.[key]);
    const event = message?.[kind];
    const eventRunId = typeof event?.runId === 'string' ? event.runId : event?.runId?.value;
    if (eventRunId !== undefined && eventRunId !== currentRunId) {
      currentRunId = eventRunId;
      currentTick = undefined;
      commands.clear();
    }
    currentTick = message?.state?.tick ?? message?.result?.processedTick ?? currentTick;
    if (direction === 'outgoing' && event?.requestId && commandActions[kind]) {
      commands.set(event.requestId, commandActions[kind]);
    }
    const summary = error ? `Invalid message: ${error}` : summarizeMessage(message);
    let colorCode = direction === 'incoming' ? 36 : 35; // Cyan / magenta.
    if (error || message?.protocolError) colorCode = 31; // Red.
    else if (message?.result) colorCode = message.result.ok ? 32 : 33; // Green / yellow.
    const label = summary.match(/^(State|Offer|Advertise|Accept offer|Withdraw|Request state sync|Set ready|Readiness acknowledged|Command succeeded|Command rejected|Protocol error|Invalid message|Unrecognized message)/)?.[0] || '';
    let detail = summary.slice(label.length).replace(/^[:\s]+/, '');
    if (label === 'Set ready') detail = `ready${detail}`;
    if (label === 'Request state sync') detail = 'request state sync';
    if (kind === 'result' && !error) {
      const action = commands.get(event.requestId) || 'command';
      detail = `${action} ${event.ok ? 'succeeded' : 'failed'}; ${detail}`;
    }
    if (label === 'Accept offer') detail = `offer ${detail}`;
    if (label === 'Invalid message') detail = `invalid message; ${detail}`;
    if (label === 'Unrecognized message') detail = 'unrecognized message';
    writeLine(direction, label, detail, colorCode);
    if (direction === 'incoming' && message?.state && !error) {
      for (const activity of summarizeActivity(message.state)) {
        writeLine(direction, activity.label, activity.detail, activity.colorCode || 36, activity.tick);
      }
    }
  };
}

const logMessage = createMessageLogger();
module.exports = { logMessage, createMessageLogger, summarizeMessage };

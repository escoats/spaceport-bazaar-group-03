const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bundle, createStrategyHarness } = require('../helpers/strategy-harness');
const { advertisement, incomingOffer } = require('../helpers/strategy-fixtures');

function setup(overrides = {}) {
  const harness = createStrategyHarness('generous', {
    self: { inventory: bundle(30, 30, 30) },
    advertisements: { items: [advertisement('peer-ad', [2], [3, 1])] },
    ...overrides,
  });
  return {
    ...harness,
  };
}

test('performs readiness handshake before deciding and advertises stock beyond reserve', () => {
  const { strategy, state, sent } = setup({ self: { inventory: bundle(20, 15, 10) } });
  strategy.onState(state);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].ready, {
    type: 1, protocolVersion: '2.0', runId: 'run', ready: true, snapshotSequence: 1,
  });
  strategy.onReadiness({ runId: 'run', ready: true, snapshotSequence: 1 });
  assert.deepEqual(sent[1].advertise.body.selling.items, [1]);
  assert.deepEqual(sent[1].advertise.body.seeking.items, [2, 3]);
});

test('accepts a free gift before advertising and waits for the next snapshot', () => {
  const { strategy, state, sent, start } = setup();
  state.offers.items = [incomingOffer('gift', bundle(0, 0, 2), bundle(0, 0, 0))];
  start();
  assert.deepEqual(sent[1].accept.body, { offerId: 'gift' });
  strategy.onResult({ runId: 'run', requestId: sent[1].accept.requestId, ok: true });
  // The next authoritative snapshot reflects that the accepted offer is closed.
  state.offers.items = [];
  state.self.inventory.components += 2;
  state.snapshotSequence += 1;
  strategy.onState(state);
  assert.equal(sent.length, 3);
  assert.ok(sent[2].advertise);
});

test('accepts a shortage reducing trade only when all resources remain at reserve', () => {
  const { state, sent, start } = setup({ self: { inventory: bundle(30, 10, 30) } });
  state.offers.items = [
    incomingOffer('unsafe', bundle(0, 10, 0), bundle(20, 0, 0)),
    incomingOffer('safe', bundle(0, 10, 0), bundle(5, 0, 0)),
  ];
  start();
  assert.equal(sent[1].accept.body.offerId, 'safe');
});

test('advertises no sale at reserve and seeks resources below the three tick horizon', () => {
  const { state, sent, start } = setup({ self: { inventory: bundle(15, 16, 17) } });
  start();
  assert.deepEqual(sent[1].advertise.body.selling.items, []);
  assert.deepEqual(sent[1].advertise.body.seeking.items, [1, 2, 3]);
});

test('offers two safe units for one advertised resource and prefers a peer need', () => {
  const { state, sent, start, settleAdvertisement } = setup({ self: { inventory: bundle(22, 15, 22), specialty: 3 } });
  start();
  settleAdvertisement();
  assert.equal(sent[2].offer.body.recipientId, 'P02');
  assert.deepEqual(sent[2].offer.body.give, bundle(0, 0, 2));
  assert.deepEqual(sent[2].offer.body.receive, bundle(0, 1, 0));
  assert.equal(sent[2].offer.body.expiresTick, 2);
});

test('does not make an offer from stock inside the reserve and safety buffer', () => {
  const { state, sent, start, settleAdvertisement } = setup({ self: { inventory: bundle(18, 15, 15) } });
  start();
  settleAdvertisement();
  assert.equal(sent.some(message => message.offer), false);
});

test('does not duplicate a command while its result is pending', () => {
  const { strategy, state, sent, start } = setup();
  start();
  assert.equal(sent.length, 2);
  strategy.onState(state);
  assert.equal(sent.length, 2);
});

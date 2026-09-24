const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFirstPassStrategy } = require('./first-pass');
const { encodeClientMessage } = require('../encoding');

const bundle = (water, food, components) => ({ water, food, components });
function setup() {
  const sent = [];
  const strategy = createFirstPassStrategy({ sendClientMessage(message) {
    encodeClientMessage(message);
    sent.push(message);
  } });
  const state = {
    runId: 'run', snapshotSequence: 1, tick: 0, phase: 2,
    self: { stationId: 'P01', specialty: 1, inventory: bundle(20, 2, 30), upkeepPerTick: bundle(1, 1, 1) },
    rules: { newCommandsPerStationPerTick: 10, maxOpenOutgoingOffers: 5, maxOfferTtlTicks: 6 },
    offers: { items: [] },
    advertisements: { items: [
      { advertisementId: 'ad1', stationId: 'P02', status: 1, expiresTick: 6, selling: { items: [2] }, seeking: { items: [3, 1] } },
    ] },
  };
  const start = () => {
    strategy.onState(state);
    strategy.onReadiness({ runId: 'run', ready: true, snapshotSequence: 1 });
  };
  return { strategy, state, sent, start };
}

test('waits for readiness and prefers specialty payment for the lowest resource', () => {
  const { strategy, state, sent } = setup();
  strategy.onState(state);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ready.snapshotSequence, 1);
  strategy.onReadiness({ runId: 'run', ready: true, snapshotSequence: 1 });
  assert.deepEqual(sent[1].offer.body.give, bundle(5, 0, 0));
  assert.deepEqual(sent[1].offer.body.receive, bundle(0, 5, 0));
  strategy.onState(state);
  assert.equal(sent.length, 2);
});

test('claims successive gifts before trading, waiting for updated inventory', () => {
  const { strategy, state, sent, start } = setup();
  state.offers.items = ['gift1', 'gift2'].map(offerId => ({
    offerId, proposerId: 'P02', recipientId: 'P01', status: 1, expiresTick: 6,
    give: bundle(0, 0, 1), receive: bundle(0, 0, 0),
  }));
  start();
  assert.equal(sent[1].accept.body.offerId, 'gift1');
  strategy.onResult({ runId: 'run', requestId: sent[1].accept.requestId, ok: true });
  assert.equal(sent.length, 2);
  state.offers.items[0].status = 2;
  state.self.inventory.components += 1;
  strategy.onState(state);
  assert.equal(sent[2].accept.body.offerId, 'gift2');
});

test('examines all advertisements and preserves upkeep when choosing payment', () => {
  const { state, sent, start } = setup();
  state.self.upkeepPerTick.water = 20;
  state.advertisements.items.unshift({ ...state.advertisements.items[0], advertisementId: 'irrelevant', selling: { items: [3] } });
  start();
  assert.deepEqual(sent[1].offer.body.give, bundle(0, 0, 5));
  assert.deepEqual(sent[1].offer.body.receive, bundle(0, 5, 0));
});

test('does not trade balanced inventory or duplicate an open outgoing offer', () => {
  const balanced = setup();
  balanced.state.self.inventory = bundle(10, 10, 10);
  balanced.start();
  assert.equal(balanced.sent.length, 1);
  const outstanding = setup();
  outstanding.state.offers.items.push({ proposerId: 'P01', recipientId: 'P02', status: 1, expiresTick: 6 });
  outstanding.start();
  assert.equal(outstanding.sent.length, 1);
});

test('accepts affordable balancing trades and rejects unaffordable payment', () => {
  for (const cost of [3, 50]) {
    const { state, sent, start } = setup();
    state.advertisements.items = [];
    state.offers.items = [{ offerId: 'trade', proposerId: 'P02', recipientId: 'P01', status: 1, expiresTick: 6,
      give: bundle(0, cost, 0), receive: bundle(0, 0, cost) }];
    start();
    assert.equal(sent.length, cost === 3 ? 2 : 1);
    if (cost === 3) assert.equal(sent[1].accept.body.offerId, 'trade');
  }
});

test('offers to a newly encountered seller even without a matching seeking resource', () => {
  for (const seeking of [[], [2]]) {
    const { strategy, state, sent, start } = setup();
    const ad = { ...state.advertisements.items[0], stationId: 'P03', seeking: { items: seeking } };
    state.advertisements.items = [];
    start();
    assert.equal(sent.length, 1);
    state.advertisements.items = [ad];
    state.snapshotSequence += 1;
    strategy.onState(state);
    assert.equal(sent[1].offer.body.recipientId, 'P03');
    assert.deepEqual(sent[1].offer.body.give, bundle(5, 0, 0));
    assert.deepEqual(sent[1].offer.body.receive, bundle(0, 5, 0));
  }
});

test('offers for a lower resource when the absolute lowest is unavailable', () => {
  const { state, sent, start } = setup();
  state.self.inventory = bundle(30, 2, 10);
  state.advertisements.items[0].selling.items = [3];
  state.advertisements.items[0].seeking.items = [];
  start();
  assert.deepEqual(sent[1].offer.body.give, bundle(5, 0, 0));
  assert.deepEqual(sent[1].offer.body.receive, bundle(0, 0, 5));
});

function incomingOffer(offerId, give, receive) {
  return { offerId, proposerId: 'P02', recipientId: 'P01', status: 1, expiresTick: 6, give, receive };
}

test('chooses the lowest unit price over arrival order and specialty payment', () => {
  const { state, sent, start } = setup();
  state.offers.items = [
    incomingOffer('specialty', bundle(0, 2, 0), bundle(2, 0, 0)),
    incomingOffer('cheap-unit-price', bundle(0, 6, 0), bundle(0, 0, 3)),
  ];
  start();
  assert.equal(sent[1].accept.body.offerId, 'cheap-unit-price');
});

test('prioritizes the scarcest resource over a cheaper less-needed resource', () => {
  const { state, sent, start } = setup();
  state.self.inventory = bundle(30, 2, 10);
  state.offers.items = [
    incomingOffer('components', bundle(0, 0, 6), bundle(1, 0, 0)),
    incomingOffer('food', bundle(0, 3, 0), bundle(3, 0, 0)),
  ];
  start();
  assert.equal(sent[1].accept.body.offerId, 'food');
});

test('breaks equal unit prices by total cost, then specialty payment', () => {
  for (const smallPayment of [bundle(0, 0, 2), bundle(2, 0, 0)]) {
    const { state, sent, start } = setup();
    state.offers.items = [
      incomingOffer('large', bundle(0, 4, 0), bundle(0, 0, 4)),
      incomingOffer('small', bundle(0, 2, 0), smallPayment),
    ];
    if (smallPayment.water) {
      state.offers.items.unshift(incomingOffer('other-small', bundle(0, 2, 0), bundle(0, 0, 2)));
    }
    start();
    assert.equal(sent[1].accept.body.offerId, 'small');
  }
});

test('accepts a balancing offer when no offer supplies the absolute scarcest resource', () => {
  const { state, sent, start } = setup();
  state.self.inventory = bundle(30, 2, 10);
  state.offers.items = [incomingOffer('components', bundle(0, 0, 4), bundle(4, 0, 0))];
  start();
  assert.equal(sent[1].accept.body.offerId, 'components');
});

test('connection handshake sends ready before the game starts and gates trading on acknowledgement', () => {
  const { createIncomingMessageHandler } = require('../services/incoming-message-handlers');
  // Each new connection constructs a new strategy, including reconnects.
  for (let connection = 0; connection < 2; connection += 1) {
    const { strategy, state, sent } = setup();
    const handle = createIncomingMessageHandler(strategy);
    state.phase = 1;
    handle({ message: 'state', state });
    assert.deepEqual(sent, [{ ready: {
      type: 1, protocolVersion: '2.0', runId: 'run', ready: true, snapshotSequence: 1,
    } }]);
    state.phase = 2;
    state.snapshotSequence = 2;
    handle({ message: 'state', state });
    assert.equal(sent.length, 1);
    handle({ message: 'readiness', readiness: { runId: 'wrong-run', ready: true, snapshotSequence: 1 } });
    assert.equal(sent.length, 1);
    handle({ message: 'readiness', readiness: { runId: 'run', ready: true, snapshotSequence: 1 } });
    assert.equal(sent.length, 2);
    assert.ok(sent[1].offer);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { bundle, createStrategyHarness } = require('../helpers/strategy-harness');
const ad = (stationId, selling, seeking) => ({ stationId, advertisementId: stationId,
  status: 1, expiresTick: 200, selling: { items: selling }, seeking: { items: seeking } });
const setup = overrides => { const h = createStrategyHarness('generous-2', overrides); h.start(); return h; };

test('P08 buys missing components before advertising or buying abundant water', () => {
  const h = setup({ self: { specialty: 2, health: 95, inventory: bundle(42, 25, 0) },
    advertisements: { items: [ad('P02', [1], [2]), ad('P03', [3], [2])] },
    rules: { newCommandsPerStationPerTick: 1 } });
  const offer = h.sent.at(-1).offer.body;
  assert.equal(offer.recipientId, 'P03');
  assert.deepEqual(offer.receive, bundle(0, 0, 4));
  assert.deepEqual(offer.give, bundle(0, 8, 0));
});

test('P09 buys six water instead of gifting surplus components', () => {
  const h = setup({ self: { specialty: 3, health: 10, inventory: bundle(0, 1, 50) },
    advertisements: { items: [ad('P02', [1], [3]), ad('P03', [2], [3])] } });
  assert.deepEqual(h.sent.at(-1).offer.body.receive, bundle(6, 0, 0));
  assert.deepEqual(h.sent.at(-1).offer.body.give, bundle(0, 0, 12));
});

test('no gift during a shortage without an available rescue trade', () => {
  const h = setup({ self: { specialty: 3, health: 10, inventory: bundle(0, 1, 50) },
    advertisements: { items: [ad('P02', [], [3])] } });
  h.settleAdvertisement();
  assert.equal(h.sent.length, 2);
});

const offer = (offerId, give, receive, proposerId = 'P02', recipientId = 'P01') => ({
  offerId, proposerId, recipientId, status: 1, expiresTick: 10, give, receive });

test('incoming trades cannot exchange one shortage for another', () => {
  const h = setup({ self: { inventory: bundle(1, 0, 30) }, offers: { items: [
    offer('unsafe', bundle(0, 6, 0), bundle(1, 0, 0)),
  ] } });
  assert.ok(!h.sent.at(-1).accept);
});

test('incoming ranking favors relief of the scarcest resource', () => {
  const h = setup({ self: { inventory: bundle(0, 10, 30) }, offers: { items: [
    offer('food', bundle(0, 20, 0), bundle()), offer('water', bundle(2), bundle()),
  ] } });
  assert.equal(h.sent.at(-1).accept.body.offerId, 'water');
});

test('incoming payment protects stock promised to outgoing offers', () => {
  const h = setup({ self: { inventory: bundle(0, 30, 30) }, offers: { items: [
    offer('promise', bundle(0, 14), bundle(), 'P01', 'P03'),
    offer('incoming', bundle(6), bundle(0, 4)),
  ] } });
  assert.ok(!h.sent.at(-1).accept);
});

test('gifts rotate among requesters and skip peers without demand', () => {
  const h = setup({ self: { health: 100, inventory: bundle(60, 30, 30) },
    rules: { maxHealth: 100 }, advertisements: { items: [
      ad('P01', [1, 2, 3], []), ad('P02', [], []), ad('P03', [], [1]), ad('P09', [], [1]),
    ] } });
  assert.equal(h.sent.at(-1).offer.body.recipientId, 'P03');
  h.strategy.onResult({ runId: h.state.runId, requestId: h.sent.at(-1).offer.requestId, ok: true });
  h.state.tick += 1;
  h.state.snapshotSequence += 1;
  h.deliverState();
  assert.equal(h.sent.at(-1).offer.body.recipientId, 'P09');
});

test('recovering stations do not give gifts', () => {
  const h = setup({ self: { health: 95, inventory: bundle(60, 30, 30) },
    rules: { maxHealth: 100 }, advertisements: { items: [ad('P01', [1, 2, 3], []), ad('P02', [], [1])] } });
  assert.equal(h.sent.length, 1);
});

test('dead stations stop issuing commands', () => {
  const h = setup({ self: { health: 0, failedOnce: true } });
  assert.equal(h.sent.length, 1);
});

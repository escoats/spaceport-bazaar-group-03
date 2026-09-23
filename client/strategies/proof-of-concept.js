// Scripted exchange from artifacts/bazaar-protobuf-starter-linux/README.md.
const assert = require('node:assert/strict');

const WATER = 1;
const FOOD = 2;
const COMPONENTS = 3;
const OPEN = 1;
const ACCEPTED = 2;
const ACTIVE = 1;
const bundle = (water, food, components) => ({ water, food, components });

function createProofOfConceptStrategy({ sendClientMessage }) {
  let currentStep = 1;
  let runId;
  let readinessSequence;
  let pendingCommand;
  let advertId;
  let previousAdvertId;
  let offerId;
  let giftOfferId;
  let giftTransactionId;
  let tradeTransactionId;
  const successfulResults = new Map();

  function sendCommand(step, kind, requestId, body) {
    currentStep = step;
    pendingCommand = { requestId, resultReceived: false };
    sendClientMessage({
      [kind]: { type: 1, protocolVersion: '2.0', runId, requestId, body }
    });
  }

  function checkAdvertisement(state, selling, seeking) {
    const own = state.advertisements.items.filter(ad => ad.stationId === 'P01');
    assert.equal(own.length, 1, 'Expected one active advertisement for P01');
    assert.equal(own[0].advertisementId, advertId);
    assert.equal(own[0].status, ACTIVE);
    assert.deepEqual(own[0].selling.items, selling);
    assert.deepEqual(own[0].seeking.items, seeking);
    assert.equal(own[0].expiresTick, 6);
  }

  function checkHistory(state) {
    assert.equal(state.transactions.items.length, 2);
    assert(state.transactions.items.some(tx => tx.transactionId === tradeTransactionId && tx.offerId === offerId));
    assert(state.transactions.items.some(tx => tx.transactionId === giftTransactionId && tx.offerId === giftOfferId));
  }

  function onState(state) {
    assert(currentStep <= 10, 'Exchange already completed');
    assert.equal(state.tick, 0);
    assert.equal(state.phase, 2); // PHASE_RUNNING
    assert.equal(state.self.stationId, 'P01');
    if (currentStep === 1) {
      assert.equal(readinessSequence, undefined, 'Expected readiness acknowledgement before another state');
      runId = state.runId;
    }
    assert.equal(state.runId, runId);
    assert.equal(state.worldVersion, currentStep === 10 ? 9 : currentStep + 1);
    assert.equal(state.snapshotSequence, currentStep === 10 ? 9 : currentStep);
    assert.deepEqual(state.self.inventory,
      currentStep <= 4 ? bundle(30, 30, 30) :
        currentStep <= 6 ? bundle(28, 31, 30) : bundle(28, 31, 31));

    if ([2, 3, 4, 7, 8].includes(currentStep)) {
      assert(pendingCommand?.resultReceived, 'Expected a successful command result before state');
      pendingCommand = undefined;
    }

    switch (currentStep) {
      case 1:
        assert.equal(state.self.specialty, WATER);
        assert(state.advertisements.items.some(ad =>
          ad.stationId === 'P02' && ad.status === ACTIVE &&
          ad.selling.items.includes(FOOD) && ad.seeking.items.includes(WATER)
        ), 'Expected P02 to advertise food for water');
        readinessSequence = state.snapshotSequence;
        sendClientMessage({ ready: {
          type: 1, protocolVersion: '2.0', runId, ready: true,
          snapshotSequence: readinessSequence
        } });
        break;
      case 2:
        checkAdvertisement(state, [WATER], [FOOD]);
        previousAdvertId = advertId;
        sendCommand(3, 'advertise', 'student-advertise-seeking-1', {
          selling: { items: [] }, seeking: { items: [COMPONENTS] }, expiresTick: 6
        });
        break;
      case 3:
        checkAdvertisement(state, [], [COMPONENTS]);
        assert.notEqual(advertId, previousAdvertId);
        assert(!state.advertisements.items.some(ad => ad.advertisementId === previousAdvertId));
        sendCommand(4, 'offer', 'student-offer-1', {
          recipientId: 'P02', give: bundle(2, 0, 0), receive: bundle(0, 1, 0), expiresTick: 6
        });
        break;
      case 4: {
        const offer = state.offers.items.find(item => item.offerId === offerId);
        assert(offer, 'Expected the outgoing offer');
        assert.equal(offer.proposerId, 'P01');
        assert.equal(offer.recipientId, 'P02');
        assert.equal(offer.status, OPEN);
        assert.deepEqual(offer.give, bundle(2, 0, 0));
        assert.deepEqual(offer.receive, bundle(0, 1, 0));
        assert.equal(offer.expiresTick, 6);
        currentStep = 5; // P02 sends the next two updates automatically.
        break;
      }
      case 5: {
        const offer = state.offers.items.find(item => item.offerId === offerId);
        assert(offer, 'Expected the accepted outgoing offer');
        assert.equal(offer.status, ACCEPTED);
        assert.equal(state.transactions.items.length, 1);
        const transaction = state.transactions.items[0];
        assert.equal(transaction.offerId, offerId);
        tradeTransactionId = transaction.transactionId;
        assert.equal(offer.transactionId.value, tradeTransactionId);
        currentStep = 6;
        break;
      }
      case 6: {
        const gift = state.offers.items.find(item =>
          item.proposerId === 'P02' && item.recipientId === 'P01' && item.status === OPEN
        );
        assert(gift, 'Expected an open gift from P02');
        assert.deepEqual(gift.give, bundle(0, 0, 1));
        assert.deepEqual(gift.receive, bundle(0, 0, 0));
        giftOfferId = gift.offerId;
        sendCommand(7, 'accept', 'student-accept-1', { offerId: giftOfferId });
        break;
      }
      case 7:
        checkHistory(state);
        checkAdvertisement(state, [], [COMPONENTS]);
        assert.equal(state.offers.items.find(item => item.offerId === giftOfferId)?.status, ACCEPTED);
        sendCommand(8, 'withdraw', 'student-withdraw-1', { objectId: advertId });
        break;
      case 8:
        assert(!state.advertisements.items.some(ad => ad.stationId === 'P01'));
        checkHistory(state);
        sendCommand(9, 'advertise', 'student-advertise-2', {
          selling: { items: [WATER] }, seeking: { items: [FOOD] }, expiresTick: 6
        });
        break;
      case 10:
        assert(!state.advertisements.items.some(ad => ad.stationId === 'P01'));
        checkHistory(state);
        assert.equal(state.requestResults.items.length, 5);
        assert.equal(new Set(state.requestResults.items.map(result => result.requestId)).size, 5);
        for (const result of state.requestResults.items) {
          assert(successfulResults.has(result.requestId), 'Unexpected stored request ID');
          assert.deepEqual(result, successfulResults.get(result.requestId));
        }
        assert.deepEqual(state.self.importedTotal, bundle(0, 1, 1));
        assert.deepEqual(state.self.exportedTotal, bundle(2, 0, 0));
        for (const field of ['producedTotal', 'consumedTotal', 'unmetTotal', 'lastProduction', 'lastUnmetUpkeep']) {
          assert.deepEqual(state.self[field], bundle(0, 0, 0), `Expected zero ${field}`);
        }
        for (const field of ['fullySuppliedTicks', 'shortageTicks', 'currentShortageStreak', 'longestShortageStreak']) {
          assert.equal(state.self[field], 0, `Expected zero ${field}`);
        }
        currentStep = 11;
        console.log('Sample exchange completed: all 10 steps passed; inventory (28,31,31).');
        break;
      default:
        assert.fail(`Unexpected state during step ${currentStep}`);
    }
  }

  function onResult(result) {
    assert([2, 3, 4, 7, 8].includes(currentStep), `Unexpected result during step ${currentStep}`);
    assert(pendingCommand && !pendingCommand.resultReceived, 'Expected one result for the pending command');
    assert.equal(result.runId, runId);
    assert.equal(result.requestId, pendingCommand.requestId);
    assert.equal(result.ok, true);
    assert.equal(result.code, 1); // RESULT_CODE_OK
    assert(result.objectId?.value, 'Expected a result object ID');
    if (currentStep === 2 || currentStep === 3) advertId = result.objectId.value;
    if (currentStep === 4) offerId = result.objectId.value;
    if (currentStep === 7) {
      assert.equal(result.objectId.value, giftOfferId);
      assert(result.transactionId?.value, 'Expected the gift transaction ID');
      giftTransactionId = result.transactionId.value;
    }
    if (currentStep === 8) assert.equal(result.objectId.value, advertId);
    successfulResults.set(result.requestId, result);
    pendingCommand.resultReceived = true;
  }

  function onProtocolError(protocolError) {
    assert.equal(currentStep, 9, 'Unexpected protocol error');
    assert.equal(protocolError.code, 2); // CONTROL_CODE_REQUEST_CAPACITY_EXCEEDED
    assert.equal(protocolError.closeSession, false);
    assert.equal(protocolError.requestId?.value, pendingCommand.requestId);
    assert.equal(protocolError.runId?.value, runId);
    pendingCommand = undefined;
    currentStep = 10;
    sendClientMessage({ sync: { type: 1, protocolVersion: '2.0', runId } });
  }

  function onReadiness(readiness) {
    assert.equal(currentStep, 1, 'Unexpected readiness acknowledgement');
    assert.notEqual(readinessSequence, undefined, 'Expected an initial state before readiness');
    assert.equal(readiness.runId, runId);
    assert.equal(readiness.ready, true);
    assert.equal(readiness.snapshotSequence, readinessSequence);
    sendCommand(2, 'advertise', 'student-advertise-1', {
      selling: { items: [WATER] }, seeking: { items: [FOOD] }, expiresTick: 6
    });
  }

  return { onState, onResult, onProtocolError, onReadiness };
}

module.exports = { createProofOfConceptStrategy };

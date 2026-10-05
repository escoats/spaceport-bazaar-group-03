const assert = require('node:assert/strict');
const { encodeClientMessage } = require('../../encoding');
const { getStrategyFactory } = require('../../strategies');

function bundle(water = 0, food = 0, components = 0) {
	return { water, food, components };
}

function mergeObjects(base, overrides) {
	const result = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value && typeof value === 'object' && !Array.isArray(value)
			&& base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
			result[key] = mergeObjects(base[key], value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function createStrategyState(overrides = {}) {
	const baseline = {
		runId: 'run',
		worldVersion: 2,
		snapshotSequence: 1,
		tick: 0,
		phase: 2,
		self: {
			stationId: 'P01',
			specialty: 1,
			inventory: bundle(30, 30, 30),
			upkeepPerTick: bundle(1, 1, 1),
		},
		rules: {
			newCommandsPerStationPerTick: 10,
			maxOpenOutgoingOffers: 5,
			maxOfferTtlTicks: 6,
		},
		offers: { items: [] },
		advertisements: {
			items: [{
				advertisementId: 'ad1',
				stationId: 'P02',
				status: 1,
				expiresTick: 6,
				selling: { items: [2] },
				seeking: { items: [1] },
			}],
		},
	};
	return mergeObjects(baseline, overrides);
}

function createStrategyHarness(strategyName, stateOverrides = {}) {
	const sent = [];
	const sendClientMessage = message => {
		encodeClientMessage(message);
		sent.push(message);
	};
	const strategy = getStrategyFactory(strategyName)({ sendClientMessage });
	const state = createStrategyState(stateOverrides);
	const deliverState = () => strategy.onState(state);
	const acknowledgeReadiness = () => strategy.onReadiness({
		runId: state.runId,
		ready: true,
		snapshotSequence: state.snapshotSequence,
	});

	return {
		strategy,
		state,
		sent,
		sendClientMessage,
		deliverState,
		acknowledgeReadiness,
		start() {
			deliverState();
			acknowledgeReadiness();
		},
		settleAdvertisement() {
			const message = sent.at(-1);
			assert.ok(message.advertise);
			const body = message.advertise.body;
			state.advertisements.items.push({
				advertisementId: 'own-ad',
				stationId: state.self.stationId,
				status: 1,
				expiresTick: body.expiresTick,
				selling: body.selling,
				seeking: body.seeking,
			});
			strategy.onResult({
				runId: state.runId,
				requestId: message.advertise.requestId,
				ok: true,
			});
			state.snapshotSequence += 1;
			strategy.onState(state);
		},
	};
}

module.exports = { bundle, createStrategyHarness, createStrategyState };
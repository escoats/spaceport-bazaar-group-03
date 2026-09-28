const { randomUUID } = require('node:crypto');

const RESOURCES = [1, 2, 3];
const FIELD = { 1: 'water', 2: 'food', 3: 'components' };
const DEFAULT_RESERVE_TICKS = 15;
const ADVERTISEMENT_HORIZON_TICKS = 3;
const ADVERTISEMENT_REFRESH_WINDOW = 2;
const SIMILAR_SURPLUS_DELTA = 1;
const MAX_TRADE_QUANTITY = 50;
const TRADE_SURPLUS_FRACTION = 0.25;
const emptyBundle = () => ({ water: 0, food: 0, components: 0 });
const total = bundle => RESOURCES.reduce((sum, id) => sum + bundle[FIELD[id]], 0);
const deficit = (bundle, reserve) => RESOURCES.reduce((sum, id) => {
  const field = FIELD[id];
  return sum + Math.max(0, reserve[field] - bundle[field]);
}, 0);
const sameItems = (left, right) => {
  const normalizedLeft = [...left].sort((a, b) => a - b);
  const normalizedRight = [...right].sort((a, b) => a - b);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((item, index) => item === normalizedRight[index]);
};

function createFirstPassStrategy({ sendClientMessage, reserveTicks = DEFAULT_RESERVE_TICKS }) {
  let state;
  let ready = false;
  let readinessSequence;
  let pending;
  let stopped = false;
  let commandTick;
  let commandsThisTick = 0;
  const attempted = new Set();

  const envelope = () => ({ type: 1, protocolVersion: '2.0', runId: state.runId });

  function reserveFor(self) {
    return RESOURCES.reduce((bundle, id) => {
      const field = FIELD[id];
      bundle[field] = self.upkeepPerTick[field] * reserveTicks;
      return bundle;
    }, emptyBundle());
  }

  function advertisementPlan(self, reserve) {
    const selling = [];
    const seeking = [];
    let largestSurplus = 0;
    let largestResource;
    for (const id of RESOURCES) {
      const field = FIELD[id];
      const surplus = self.inventory[field] - reserve[field];
      const horizon = self.upkeepPerTick[field] * ADVERTISEMENT_HORIZON_TICKS;
      if (surplus > 0 && (surplus > largestSurplus
        || (surplus === largestSurplus && id === self.specialty))) {
        largestSurplus = surplus;
        largestResource = id;
      }
      if (self.inventory[field] < reserve[field] + horizon) seeking.push(id);
    }
    if (largestResource !== undefined
      && self.inventory[FIELD[largestResource]] >= reserve[FIELD[largestResource]]
        + self.upkeepPerTick[FIELD[largestResource]] * ADVERTISEMENT_HORIZON_TICKS) {
      selling.push(largestResource);
    }
    return { selling, seeking };
  }

  function maybeAdvertise(self, tick, reserve) {
    const plan = advertisementPlan(self, reserve);
    const active = state.advertisements.items.find(ad => ad.stationId === self.stationId
      && ad.status === 1 && ad.expiresTick > tick);
    const ttl = Math.min(12, state.rules.maxPublicationTtlTicks ?? 12);
    if (ttl < 1) return false;
    if (!plan.selling.length && !plan.seeking.length) return false;
    const unchanged = active
      && sameItems(active.selling.items, plan.selling)
      && sameItems(active.seeking.items, plan.seeking)
      && active.expiresTick - tick > ADVERTISEMENT_REFRESH_WINDOW;
    if (unchanged) return false;
    const expiresTick = tick + ttl;
    const key = `advertise:${plan.selling.join(',')}:${plan.seeking.join(',')}:${expiresTick}`;
    if (attempted.has(key)) return false;
    command('advertise', {
      selling: { items: plan.selling },
      seeking: { items: plan.seeking },
      expiresTick,
    }, key);
    return true;
  }

  function command(kind, body, key) {
    attempted.add(key);
    commandsThisTick += 1;
    pending = { requestId: randomUUID(), resultReceived: false };
    sendClientMessage({ [kind]: { ...envelope(), requestId: pending.requestId, body } });
  }

  function decide() {
    if (!ready || stopped || pending || state.phase !== 2) return;
    if (commandsThisTick >= state.rules.newCommandsPerStationPerTick) return;
    const { self, tick } = state;
    const open = state.offers.items.filter(offer => offer.status === 1 && offer.expiresTick > tick);
    const incoming = open.filter(offer => offer.recipientId === self.stationId);

    // Gifts cost nothing, so claim them before considering any paid trade.
    const gift = incoming.find(offer => total(offer.receive) === 0 && total(offer.give) > 0
      && !attempted.has(offer.offerId));
    if (gift) return command('accept', { offerId: gift.offerId }, gift.offerId);

    const inventory = self.inventory;
    const reserve = reserveFor(self);
    const currentDeficit = deficit(inventory, reserve);

    const beneficial = incoming.filter(offer => {
      if (attempted.has(offer.offerId)) return false;
      const after = emptyBundle();
      let nonSpecialtyPaymentBelowReserve = false;
      for (const id of RESOURCES) {
        const field = FIELD[id];
        if (offer.receive[field] > inventory[field]) return false;
        after[field] = inventory[field] - offer.receive[field] + offer.give[field];
        if (offer.receive[field] > 0 && after[field] < reserve[field]
          && field !== FIELD[self.specialty]) nonSpecialtyPaymentBelowReserve = true;
      }
      const improvesDeficit = deficit(after, reserve) < currentDeficit;
      return improvesDeficit && !nonSpecialtyPaymentBelowReserve;
    });
    beneficial.sort((a, b) => {
      const aAfter = RESOURCES.reduce((bundle, id) => {
        const field = FIELD[id];
        bundle[field] = inventory[field] - a.receive[field] + a.give[field];
        return bundle;
      }, emptyBundle());
      const bAfter = RESOURCES.reduce((bundle, id) => {
        const field = FIELD[id];
        bundle[field] = inventory[field] - b.receive[field] + b.give[field];
        return bundle;
      }, emptyBundle());
      return deficit(aAfter, reserve) - deficit(bAfter, reserve)
        || total(a.receive) - total(b.receive)
        || Number(b.receive[FIELD[self.specialty]] > 0)
          - Number(a.receive[FIELD[self.specialty]] > 0);
    });
    if (beneficial.length) {
      const offer = beneficial[0];
      return command('accept', { offerId: offer.offerId }, offer.offerId);
    }

    if (maybeAdvertise(self, tick, reserve)) return;
    if (open.some(offer => offer.proposerId === self.stationId)) return;

    // Inspect every active peer advertisement, then rank all useful matches.
    const candidates = [];
    for (const ad of state.advertisements.items) {
      if (ad.stationId === self.stationId || ad.status !== 1 || ad.expiresTick <= tick) continue;
      for (const receive of ad.selling.items) {
        if (!RESOURCES.includes(receive)) continue;
        // A selling advertisement is enough to propose a trade; seeking
        // is a preference, not a requirement for making an offer.
        for (const give of RESOURCES) {
          if (!RESOURCES.includes(give) || give === receive) continue;
          const key = `${ad.advertisementId}:${give}:${receive}`;
          if (attempted.has(key)) continue;
          const ownAdvertisement = state.advertisements.items.find(ad => ad.stationId === self.stationId
            && ad.status === 1 && ad.expiresTick > tick);
          const advertised = ownAdvertisement?.selling.items.includes(give)
            ? self.upkeepPerTick[FIELD[give]] * ADVERTISEMENT_HORIZON_TICKS : 0;
          const protectedAmount = reserve[FIELD[give]] + advertised;
          const surplus = inventory[FIELD[give]] - protectedAmount;
          const quantity = Math.min(
            MAX_TRADE_QUANTITY,
            Math.max(0, Math.floor(surplus * TRADE_SURPLUS_FRACTION)),
          );
          if (quantity <= 0) continue;
          candidates.push({ ad, give, receive, quantity, key, surplus });
        }
      }
    }
    candidates.sort((a, b) => {
      const surplusDifference = b.surplus - a.surplus;
      if (Math.abs(surplusDifference) > SIMILAR_SURPLUS_DELTA) return surplusDifference;
      return Number(b.give === self.specialty) - Number(a.give === self.specialty)
        || Number(b.ad.seeking.items.includes(b.give)) - Number(a.ad.seeking.items.includes(a.give))
        || inventory[FIELD[a.receive]] - inventory[FIELD[b.receive]];
    });
    const best = candidates[0];
    if (!best || state.rules.maxOpenOutgoingOffers < 1 || state.rules.maxOfferTtlTicks < 1) return;
    const give = emptyBundle();
    const receive = emptyBundle();
    give[FIELD[best.give]] = best.quantity;
    receive[FIELD[best.receive]] = best.quantity;
    command('offer', {
      recipientId: best.ad.stationId, give, receive,
      expiresTick: tick + Math.min(2, state.rules.maxOfferTtlTicks),
    }, best.key);
  }

  function onState(nextState) {
    if (!state || nextState.runId !== state.runId) {
      ready = false;
      readinessSequence = undefined;
      pending = undefined;
      stopped = false;
      commandTick = undefined;
    }
    state = nextState;
    if (commandTick !== state.tick) {
      commandTick = state.tick;
      commandsThisTick = 0;
      attempted.clear();
    }
    if (pending?.resultReceived) pending = undefined;
    // The connection handshake must wait for this first state: ready requires
    // its run ID and snapshot sequence, even when the game has not started.
    if (readinessSequence === undefined) {
      readinessSequence = state.snapshotSequence;
      sendClientMessage({ ready: { ...envelope(), ready: true, snapshotSequence: readinessSequence } });
      return;
    }
    decide();
  }

  function onReadiness(readiness) {
    if (!state || readiness.runId !== state.runId || readiness.snapshotSequence !== readinessSequence) return;
    ready = readiness.ready;
    decide();
  }

  function onResult(result) {
    if (result.runId !== state?.runId || result.requestId !== pending?.requestId) return;
    // Wait for the following snapshot before spending against new inventory.
    pending.resultReceived = true;
    if (!result.ok) {
      console.warn(`First-pass command rejected: ${result.code}`);
      if (result.code === 4) commandsThisTick = state.rules.newCommandsPerStationPerTick;
    }
  }

  function onProtocolError(error) {
    console.warn(`First-pass protocol error: ${error.code}`);
    // Protocol errors may have no following snapshot. Stop issuing commands
    // rather than repeatedly consuming capacity or sending malformed requests.
    pending = undefined;
    stopped = true;
  }

  return { onState, onReadiness, onResult, onProtocolError };
}

module.exports = { createFirstPassStrategy };

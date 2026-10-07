const { randomUUID } = require('node:crypto');

const RESOURCES = [1, 2, 3];
const FIELD = { 1: 'water', 2: 'food', 3: 'components' };
const DEFAULT_RESERVE_TICKS = 15;
const ADVERTISEMENT_HORIZON_TICKS = 3;
const TRADE_BATCH_CAP = 6;
const OFFER_SAFETY_TICKS = 2;
/** Create a fresh resource bundle with no units assigned. */
const emptyBundle = () => ({ water: 0, food: 0, components: 0 });
/** Sum all resource quantities in a bundle, for example to detect free gifts. */
const total = bundle => RESOURCES.reduce((sum, id) => sum + bundle[FIELD[id]], 0);
/** Compare resource ID lists without depending on their ordering. */
const sameItems = (left, right) => {
  const normalizedLeft = [...left].sort((a, b) => a - b);
  const normalizedRight = [...right].sort((a, b) => a - b);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((item, index) => item === normalizedRight[index]);
};

/**
 * Build the event-driven strategy used by one station.
 *
 * The strategy keeps the same connection and command lifecycle as first-pass,
 * but chooses actions with two priorities: do not spend resources needed for
 * survival, and make useful resources available to other stations whenever it
 * can. `sendClientMessage` is the transport callback, and `reserveTicks` lets
 * callers tune how much upkeep inventory is protected from ordinary trades.
 */
function createGenerous2Strategy({ sendClientMessage, reserveTicks = DEFAULT_RESERVE_TICKS }) {
  let state;
  let ready = false;
  let readinessSequence;
  let pending;
  let stopped = false;
  let commandTick;
  let commandsThisTick = 0;
  const attempted = new Set();
  const giftCounts = new Map();

  const coverage = (self, id) => self.upkeepPerTick[FIELD[id]] > 0
    ? self.inventory[FIELD[id]] / self.upkeepPerTick[FIELD[id]] : Infinity;
  const targetFor = (self, reserve, id) => reserve[FIELD[id]]
    + self.upkeepPerTick[FIELD[id]] * ADVERTISEMENT_HORIZON_TICKS;
  const needs = (self, reserve) => RESOURCES.filter(id =>
    self.inventory[FIELD[id]] < targetFor(self, reserve, id))
    .sort((a, b) => coverage(self, a) - coverage(self, b));

  /**
   * Convert the station's per-tick upkeep rates into minimum inventory targets.
   * Each resource is protected independently, so a surplus of one resource
   * cannot compensate for a shortage of another. The default target is fifteen
   * ticks of upkeep for each resource.
   */
  function reserveFor(self) {
    return RESOURCES.reduce((bundle, id) => {
      const field = FIELD[id];
      bundle[field] = self.upkeepPerTick[field] * reserveTicks;
      return bundle;
    }, emptyBundle());
  }

  /**
   * Build the station's public offer and request lists from its current stock.
   * Resources are listed as for sale only when stock is strictly above the
   * protected reserve plus three ticks of upkeep. A resource is listed as
   * wanted once stock falls below that same target.
   */
  function advertisementPlan(self, reserve) {
    const selling = [];
    const seeking = [];
    for (const id of RESOURCES) {
      const field = FIELD[id];
      const horizon = self.upkeepPerTick[field] * ADVERTISEMENT_HORIZON_TICKS;
      const target = reserve[field] + horizon;
      if (self.inventory[field] > target) selling.push(id);
      if (self.inventory[field] < target) seeking.push(id);
    }
    // Keep the station's produced resource first when the market consumes
    // listing order to resolve which item to show or match first.
    selling.sort((a, b) => Number(b === self.specialty) - Number(a === self.specialty));
    return { selling, seeking };
  }

  /**
   * Publish the current plan if it differs from the station's active listing,
   * or when the listing has expired. The method avoids empty listings,
   * respects the market's publication TTL limit, and records the attempted
   * plan so repeated snapshots in one tick cannot send duplicate commands.
   * Returns true only when it sent an advertise command.
   */
  function maybeAdvertise(self, tick, reserve) {
    const plan = advertisementPlan(self, reserve);
    const active = state.advertisements.items.find(ad => ad.stationId === self.stationId
      && ad.status === 1 && ad.expiresTick > tick);
    const ttl = Math.min(12, state.rules.maxPublicationTtlTicks ?? 12);
    if (ttl < 1 || (!plan.selling.length && !plan.seeking.length)) return false;
    const unchanged = active
      && sameItems(active.selling.items, plan.selling)
      && sameItems(active.seeking.items, plan.seeking);
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

  /**
   * Send one market command using the required protocol envelope.
   * The request ID is retained as `pending`; later decisions wait until its
   * result arrives and a following state snapshot provides updated inventory.
   * The key also marks the action as attempted for this tick.
   */
  function command(kind, body, key) {
    attempted.add(key);
    commandsThisTick += 1;
    pending = { requestId: randomUUID(), resultReceived: false };
    sendClientMessage({ [kind]: {
      type: 1,
      protocolVersion: '2.0',
      runId: state.runId,
      requestId: pending.requestId,
      body,
    } });
  }

  /** Accept offers that replenish resources running low without spending
   * another resource below its reserve.
   * Prioritize gains in the scarcest resource first, then the next scarcest.
   */
  function acceptUsefulIncoming(incoming, self, reserve, available) {
    const shortages = needs(self, reserve);
    const useful = incoming.filter(offer => {
      if (attempted.has(offer.offerId)) return false;
      for (const id of RESOURCES) {
        const field = FIELD[id];
        const after = available[field] - offer.receive[field] + offer.give[field];
        if (offer.receive[field] > available[field]
          || after < Math.min(available[field], reserve[field])) return false;
      }
      return shortages.some(id => offer.give[FIELD[id]] > offer.receive[FIELD[id]]);
    });
    useful.sort((a, b) => {
      for (const id of shortages) {
        const field = FIELD[id];
        const deficit = targetFor(self, reserve, id) - self.inventory[field];
        const gain = offer => Math.min(deficit,
          Math.max(0, offer.give[field] - offer.receive[field]));
        const difference = gain(b) - gain(a);
        if (difference) return difference;
      }
      return total(a.receive) - total(b.receive);
    });
    return useful[0];
  }

  /**
   * Give away specialty stock above the advertisement target once inventory
   * exceeds twice that target. Prefer an active peer asking for the specialty.
   */
  function makeSpecialtyGift(self, tick, reserve, open) {
    const specialty = self.specialty;
    const field = FIELD[specialty];
    const threshold = reserve[field]
      + self.upkeepPerTick[field] * ADVERTISEMENT_HORIZON_TICKS;
    if (needs(self, reserve).length || self.health < state.rules.maxHealth
      || self.inventory[field] <= 2 * threshold
      || open.some(offer => offer.proposerId === self.stationId)
      || state.rules.maxOpenOutgoingOffers < 1 || state.rules.maxOfferTtlTicks < 1) return false;

    const peers = state.advertisements.items
      .filter(ad => ad.stationId !== self.stationId && ad.status === 1 && ad.expiresTick > tick
        && ad.seeking.items.includes(specialty))
      .sort((a, b) => (giftCounts.get(a.stationId) || 0)
        - (giftCounts.get(b.stationId) || 0)
        || a.stationId.localeCompare(b.stationId));
    const recipient = peers[0];
    if (!recipient) return false;

    const key = `specialty-gift:${recipient.stationId}:${specialty}:${self.inventory[field] - threshold}`;
    if (attempted.has(key)) return false;
    const give = emptyBundle();
    give[field] = self.inventory[field] - threshold
      - self.upkeepPerTick[field] * OFFER_SAFETY_TICKS;
    if (give[field] < 1) return false;
    giftCounts.set(recipient.stationId, (giftCounts.get(recipient.stationId) || 0) + 1);
    command('offer', {
      recipientId: recipient.stationId,
      give,
      receive: emptyBundle(),
      expiresTick: tick + Math.min(2, state.rules.maxOfferTtlTicks),
    }, key);
    return true;
  }

  /** Buy only needed resources, scarcest first. Batch up to six units at
   * the generous two-for-one ratio while protecting payment reserves.
   */
  function makeGenerousOffer(self, tick, inventory, reserve, open) {
    if (open.some(offer => offer.proposerId === self.stationId)) return false;
    const candidates = [];
    for (const ad of state.advertisements.items) {
      if (ad.stationId === self.stationId || ad.status !== 1 || ad.expiresTick <= tick) continue;
      for (const receive of needs(self, reserve)) {
        if (!ad.selling.items.includes(receive)) continue;
        for (const give of RESOURCES) {
          if (give === receive) continue;
          const key = `${ad.advertisementId}:${give}:${receive}`;
          if (attempted.has(key)) continue;
          const field = FIELD[give];
          const safeToGive = inventory[field] - reserve[field]
            - self.upkeepPerTick[field] * OFFER_SAFETY_TICKS;
          const quantity = Math.min(TRADE_BATCH_CAP, Math.floor(safeToGive / 2),
            targetFor(self, reserve, receive) - inventory[FIELD[receive]]);
          if (quantity < 1) continue;
          candidates.push({ ad, give, receive, key, quantity,
            wanted: ad.seeking.items.includes(give) });
        }
      }
    }
    candidates.sort((a, b) => coverage(self, a.receive) - coverage(self, b.receive)
      || Number(b.wanted) - Number(a.wanted)
      || Number(b.give === self.specialty) - Number(a.give === self.specialty)
      || b.quantity - a.quantity);
    const best = candidates[0];
    if (!best || state.rules.maxOpenOutgoingOffers < 1 || state.rules.maxOfferTtlTicks < 1) return false;
    const give = emptyBundle();
    const receive = emptyBundle();
    give[FIELD[best.give]] = 2 * best.quantity;
    receive[FIELD[best.receive]] = best.quantity;
    command('offer', {
      recipientId: best.ad.stationId, give, receive,
      expiresTick: tick + Math.min(2, state.rules.maxOfferTtlTicks),
    }, best.key);
    return true;
  }

  /**
   * Prioritize actions: safely accept offers for resources running low,
   * buy needed resources, update advertisements, then share healthy surplus. Decisions run only in the active game phase,
   * after readiness, with no command awaiting its result, and within the
   * per-tick command limit.
   */
  function decide() {
    if (!ready || stopped || pending || state.phase !== 2
      || state.self.failedOnce || state.self.health === 0) return;
    if (commandsThisTick >= state.rules.newCommandsPerStationPerTick) return;
    const { self, tick } = state;
    const open = state.offers.items.filter(offer => offer.status === 1 && offer.expiresTick > tick);
    const incoming = open.filter(offer => offer.recipientId === self.stationId);
    const reserve = reserveFor(self);
    // Offers do not reserve stock on the server; protect outstanding promises.
    const available = { ...self.inventory };
    for (const offer of open.filter(offer => offer.proposerId === self.stationId)) {
      for (const id of RESOURCES) available[FIELD[id]] -= offer.give[FIELD[id]];
    }
    const useful = acceptUsefulIncoming(incoming, self, reserve, available);
    if (useful) return command('accept', { offerId: useful.offerId }, useful.offerId);
    if (needs(self, reserve).length
      && makeGenerousOffer(self, tick, self.inventory, reserve, open)) return;
    if (maybeAdvertise(self, tick, reserve)) return;
    makeSpecialtyGift(self, tick, reserve, open);
  }

  /**
   * Receive a full state snapshot and drive the strategy lifecycle.
   * A new run resets readiness and pending-command state. A new tick clears
   * per-tick duplicate tracking and command counts. The first snapshot is used
   * for the readiness handshake; later snapshots release completed commands
   * and trigger a new decision when the station is ready.
   */
  function onState(nextState) {
    if (!state || nextState.runId !== state.runId) {
      ready = false;
      readinessSequence = undefined;
      pending = undefined;
      stopped = false;
      commandTick = undefined;
      giftCounts.clear();
    }
    state = nextState;
    if (commandTick !== state.tick) {
      commandTick = state.tick;
      commandsThisTick = 0;
      attempted.clear();
    }
    if (pending?.resultReceived) pending = undefined;
    if (readinessSequence === undefined) {
      readinessSequence = state.snapshotSequence;
      sendClientMessage({ ready: {
        type: 1,
        protocolVersion: '2.0',
        runId: state.runId,
        ready: true,
        snapshotSequence: readinessSequence,
      } });
      return;
    }
    decide();
  }

  /**
   * Record the server's readiness acknowledgement for this run and initial
   * snapshot. Stale acknowledgements are ignored so they cannot unlock actions
   * for a different connection or game state. A valid acknowledgement resumes
   * decision-making if the game is already in its active phase.
   */
  function onReadiness(readiness) {
    if (!state || readiness.runId !== state.runId
      || readiness.snapshotSequence !== readinessSequence) return;
    ready = readiness.ready;
    decide();
  }

  /**
   * Match a command result to the outstanding request and mark it complete.
   * The strategy still waits for the next snapshot before making another
   * inventory-based decision. A command-limit rejection consumes the rest of
   * this tick's command allowance; other rejections are logged for diagnosis.
   */
  function onResult(result) {
    if (result.runId !== state?.runId || result.requestId !== pending?.requestId) return;
    pending.resultReceived = true;
    if (!result.ok) {
      console.warn(`Generous-2 command rejected: ${result.code}`);
      if (result.code === 11) stopped = true;
      if (result.code === 4) commandsThisTick = state.rules.newCommandsPerStationPerTick;
    }
  }

  /**
   * Handle a protocol error that may not be followed by a normal result.
   * Since the strategy cannot safely infer the command's effect, it clears the
   * pending marker and stops issuing commands for this run.
   */
  function onProtocolError(error) {
    console.warn(`Generous-2 protocol error: ${error.code}`);
    pending = undefined;
    stopped = true;
  }

  return { onState, onReadiness, onResult, onProtocolError };
}

module.exports = { createGenerous2Strategy };

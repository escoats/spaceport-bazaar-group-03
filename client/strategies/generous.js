const { randomUUID } = require('node:crypto');

const RESOURCES = [1, 2, 3];
const FIELD = { 1: 'water', 2: 'food', 3: 'components' };
const DEFAULT_RESERVE_TICKS = 15;
const ADVERTISEMENT_HORIZON_TICKS = 3;
const ADVERTISEMENT_REFRESH_WINDOW = 2;
const GENEROUS_GIVE_QUANTITY = 2;
const GENEROUS_RECEIVE_QUANTITY = 1;
const OFFER_SAFETY_TICKS = 2;
/** Create a fresh resource bundle with no units assigned. */
const emptyBundle = () => ({ water: 0, food: 0, components: 0 });
/** Sum all resource quantities in a bundle, for example to detect free gifts. */
const total = bundle => RESOURCES.reduce((sum, id) => sum + bundle[FIELD[id]], 0);
/** Add the units missing below reserve across all resource types. */
const deficit = (bundle, reserve) => RESOURCES.reduce((sum, id) => {
  const field = FIELD[id];
  return sum + Math.max(0, reserve[field] - bundle[field]);
}, 0);
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
function createGenerousStrategy({ sendClientMessage, reserveTicks = DEFAULT_RESERVE_TICKS }) {
  let state;
  let ready = false;
  let readinessSequence;
  let pending;
  let stopped = false;
  let commandTick;
  let commandsThisTick = 0;
  const attempted = new Set();

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
   * Anything strictly above its protected reserve is listed as for sale so
   * peers can discover available resources. A resource is listed as wanted
   * once stock falls below reserve plus three ticks of upkeep, giving peers
   * time to respond before that resource reaches the survival reserve.
   */
  function advertisementPlan(self, reserve) {
    const selling = [];
    const seeking = [];
    for (const id of RESOURCES) {
      const field = FIELD[id];
      const horizon = self.upkeepPerTick[field] * ADVERTISEMENT_HORIZON_TICKS;
      if (self.inventory[field] > reserve[field]) selling.push(id);
      if (self.inventory[field] < reserve[field] + horizon) seeking.push(id);
    }
    return { selling, seeking };
  }

  /**
   * Publish the current plan if it differs from the station's active listing,
   * or refresh it when its expiry is close. The method avoids empty listings,
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

  /**
   * Choose an incoming offer worth accepting. Free gifts are preferred because
   * they consume no inventory. Otherwise, simulate each affordable trade and
   * require it to improve the total shortage while leaving every resource at
   * or above its reserve. Among qualifying trades, prefer the one requiring
   * the least payment. Returns an offer or undefined if none is safe and useful.
   */
  function acceptUsefulIncoming(incoming, inventory, reserve) {
    const gift = incoming.find(offer => total(offer.receive) === 0 && total(offer.give) > 0
      && !attempted.has(offer.offerId));
    if (gift) return gift;
    const currentDeficit = deficit(inventory, reserve);
    const useful = incoming.filter(offer => {
      if (attempted.has(offer.offerId)) return false;
      const after = emptyBundle();
      for (const id of RESOURCES) {
        const field = FIELD[id];
        if (offer.receive[field] > inventory[field]) return false;
        after[field] = inventory[field] - offer.receive[field] + offer.give[field];
        if (after[field] < reserve[field]) return false;
      }
      return deficit(after, reserve) < currentDeficit;
    });
    useful.sort((a, b) => total(a.receive) - total(b.receive));
    return useful[0];
  }

  /**
   * Find a peer selling a resource and make a deliberately favorable offer.
   * Candidate payments must come from stock left after both the reserve and a
   * two-tick upkeep buffer, protecting the station while the offer is open.
   * Offers exchange two units of a safe resource for one unit the peer sells.
   * The peer's seeking list and then the station's specialty break ties. Only
   * one outgoing offer is kept open at a time, and market limits bound its TTL.
   */
  function makeGenerousOffer(self, tick, inventory, reserve, open) {
    if (open.some(offer => offer.proposerId === self.stationId)) return;
    const candidates = [];
    for (const ad of state.advertisements.items) {
      if (ad.stationId === self.stationId || ad.status !== 1 || ad.expiresTick <= tick) continue;
      for (const receive of ad.selling.items) {
        if (!RESOURCES.includes(receive)) continue;
        for (const give of RESOURCES) {
          if (give === receive) continue;
          const key = `${ad.advertisementId}:${give}:${receive}`;
          if (attempted.has(key)) continue;
          const field = FIELD[give];
          // Leave two more upkeep ticks available while the offer can be accepted.
          const safeToGive = inventory[field] - reserve[field]
            - self.upkeepPerTick[field] * OFFER_SAFETY_TICKS;
          if (safeToGive < GENEROUS_GIVE_QUANTITY) continue;
          // A two-for-one offer is intentionally favorable to the other station.
          candidates.push({ ad, give, receive, key,
            wanted: ad.seeking.items.includes(give) });
        }
      }
    }
    candidates.sort((a, b) => Number(b.wanted) - Number(a.wanted)
      || Number(b.give === self.specialty) - Number(a.give === self.specialty));
    const best = candidates[0];
    if (!best || state.rules.maxOpenOutgoingOffers < 1 || state.rules.maxOfferTtlTicks < 1) return;
    const give = emptyBundle();
    const receive = emptyBundle();
    give[FIELD[best.give]] = GENEROUS_GIVE_QUANTITY;
    receive[FIELD[best.receive]] = GENEROUS_RECEIVE_QUANTITY;
    command('offer', {
      recipientId: best.ad.stationId,
      give,
      receive,
      expiresTick: tick + Math.min(2, state.rules.maxOfferTtlTicks),
    }, best.key);
  }

  /**
   * Apply the action priority for the latest state: accept a gift or safe
   * shortage-reducing offer first, update the public advertisement next, then
   * propose a generous trade. Decisions run only in the active game phase,
   * after readiness, with no command awaiting its result, and within the
   * per-tick command limit.
   */
  function decide() {
    if (!ready || stopped || pending || state.phase !== 2) return;
    if (commandsThisTick >= state.rules.newCommandsPerStationPerTick) return;
    const { self, tick } = state;
    const open = state.offers.items.filter(offer => offer.status === 1 && offer.expiresTick > tick);
    const incoming = open.filter(offer => offer.recipientId === self.stationId);
    const reserve = reserveFor(self);
    const useful = acceptUsefulIncoming(incoming, self.inventory, reserve);
    if (useful) return command('accept', { offerId: useful.offerId }, useful.offerId);
    if (maybeAdvertise(self, tick, reserve)) return;
    makeGenerousOffer(self, tick, self.inventory, reserve, open);
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
      console.warn(`Generous command rejected: ${result.code}`);
      if (result.code === 4) commandsThisTick = state.rules.newCommandsPerStationPerTick;
    }
  }

  /**
   * Handle a protocol error that may not be followed by a normal result.
   * Since the strategy cannot safely infer the command's effect, it clears the
   * pending marker and stops issuing commands for this run.
   */
  function onProtocolError(error) {
    console.warn(`Generous protocol error: ${error.code}`);
    pending = undefined;
    stopped = true;
  }

  return { onState, onReadiness, onResult, onProtocolError };
}

module.exports = { createGenerousStrategy };

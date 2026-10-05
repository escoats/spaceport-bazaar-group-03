function incomingOffer(offerId, give, receive, overrides = {}) {
	return {
		offerId,
		proposerId: 'P02',
		recipientId: 'P01',
		status: 1,
		expiresTick: 6,
		give,
		receive,
		...overrides,
	};
}

function advertisement(advertisementId, selling = [], seeking = [], overrides = {}) {
	return {
		advertisementId,
		stationId: 'P02',
		status: 1,
		expiresTick: 6,
		selling: { items: selling },
		seeking: { items: seeking },
		...overrides,
	};
}

module.exports = { advertisement, incomingOffer };

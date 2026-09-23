function logMessage(direction, message) {
  const label = direction === 'incoming'
    ? 'INCOMING MESSAGE'
    : 'OUTGOING MESSAGE';

  console.log([
    '',
    `==================== ${label} ====================`,
    JSON.stringify(message, null, 2),
    `==================== END ${direction.toUpperCase()} MESSAGE ====================`,
    '',
  ].join('\n'));
}

module.exports = { logMessage };

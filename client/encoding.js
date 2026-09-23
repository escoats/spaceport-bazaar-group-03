// Encode outgoing client messages & decode incoming server messages.
const path = require('node:path');
const protobuf = require('protobufjs');

const schemaPath = path.resolve(__dirname, '../artifacts/bazaar-protobuf-starter-linux/bazaar.proto');
const schema = protobuf.loadSync(schemaPath);
const ServerMessage = schema.lookupType('bazaar.v2.ServerMessage');
const ClientMessage = schema.lookupType('bazaar.v2.ClientMessage');

// This schema uses integer numeric fields only. Keep application numbers exact;
// supporting the full uint64 range would require a BigInt/string contract instead.
function assertSafeIntegers(value, fieldPath) {
  if (protobuf.util.Long.isLong(value)) {
    assertSafeIntegers(value.toNumber(), fieldPath);
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${fieldPath} must be a safe JavaScript integer`);
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assertSafeIntegers(child, `${fieldPath}.${key}`);
    }
  }
}

function decodeServerMessage(bytes) {
  const decoded = ServerMessage.decode(bytes);
  assertSafeIntegers(decoded, 'ServerMessage');
  return ServerMessage.toObject(decoded, {
    longs: Number,
    arrays: true,
    oneofs: true,
  });
}

function encodeClientMessage(message) {
  assertSafeIntegers(message, 'ClientMessage');
  const validationError = ClientMessage.verify(message);
  if (validationError) {
    throw new Error(`Invalid client message: ${validationError}`);
  }

  return ClientMessage.encode(ClientMessage.create(message)).finish();
}

module.exports = { decodeServerMessage, encodeClientMessage };

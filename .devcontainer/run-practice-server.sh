#!/usr/bin/env sh
set -eu

case "$(uname -m)" in
  aarch64|arm64)
    server="spaceport-validate-linux-arm64"
    ;;
  x86_64|amd64)
    server="spaceport-validate-linux-x86_64"
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

exec "./artifacts/bazaar-protobuf-starter-linux/$server" --codec protobuf "$@"

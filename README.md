# Bazaar

## Dev container

Open this repository in its dev container, then start the practice server from
the repository root:

```sh
./.devcontainer/run-practice-server.sh
```

Run the client in a second terminal in the same container and connect it to
`ws://127.0.0.1:3001/ws`. The server writes `validation-credentials.json` and
`validation-report.json` in the repository root. See
[`artifacts/bazaar-protobuf-starter-linux/README.md`](artifacts/bazaar-protobuf-starter-linux/README.md)
for the exercise and protocol details.

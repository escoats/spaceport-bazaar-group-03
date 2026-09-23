# Bazaar

## Dev container

Open this repository in its dev container, then start the practice server from
the repository root:

```sh
./.devcontainer/run-practice-server.sh
```

Run the client in a second terminal in the same container and connect it to
`ws://127.0.0.1:3001/ws`. The server writes `validation-credentials.json` and
`validation-report.json` in the repository root.

## Client configuration

Start the client:
```sh
cd client
npm install
npm start -- --strategy <strategy-name>
```

## Strategies

Strategies define the client's decision-making logic. To watch the example exchange from `artifacts/bazaar-protobuf-starter-linux/README.md` play out, run:
`npm start -- --strategy=proof-of-concept`
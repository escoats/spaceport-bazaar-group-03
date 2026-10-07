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

To connect to a specific server with a token without changing `.env`, set the
values for that process on the command line:

```sh
BAZAAR_WS_URL="ws://<server-host>:<server-port>/ws" \
BAZAAR_ACCESS_TOKEN="<access-token>" \
npm start -- --strategy=<strategy-name>
```

`BAZAAR_WS_URL` and `BAZAAR_ACCESS_TOKEN` override the values in `.env` for
that client only.

To start multiple clients with the same policy on a test server, use the launcher
and provide the desired client count:

```sh
npm run start:many -- --count 9 --strategy=<strategy-name>
```

The count defaults to 3. Press `Ctrl-C` to stop all
clients started by the launcher together.
This launcher uses the same credentials in .env for all clients, so it won't work for a production-level server that enforces authentication.

## Strategies

Strategies define the client's decision-making logic. To watch the example exchange from `artifacts/bazaar-protobuf-starter-linux/README.md` play out, run:
`npm start -- --strategy=proof-of-concept`

## Game logs

The client prints one-line event summaries to the console and creates two paired
log files per run in `client/logs/`:

- `messages-<timestamp>-<unique-id>.jsonl`: full incoming and outgoing messages.
- `messages-<timestamp>-<unique-id>-summary.log`: the same readable summaries as
  the console, without color or bold escape codes.

Both files are created when the first message is logged.

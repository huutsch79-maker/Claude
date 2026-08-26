# Alpine-based Docker CLI image — deliberately not a Node base image: this
# service's whole job is talking to the host's Docker daemon and running
# git, both easiest to get pre-built on the official docker CLI image.
# nodejs is added on top just to run the small HTTP server.
FROM docker:26-cli

RUN apk add --no-cache nodejs git docker-cli-compose

WORKDIR /app
# package.json has no dependencies (server.js only imports node: builtins) —
# it's copied in purely for its "type": "module" field, which is what lets
# Node parse server.js's `import` syntax at all. Without it in the image,
# Node defaults to CommonJS and refuses to parse `import` with a
# SyntaxError — this was silently missing before and only surfaced once a
# separate ENTRYPOINT bug (see below) stopped masking it.
COPY package.json ./
COPY server.js ./

EXPOSE 8082
# The docker:26-cli base image's own ENTRYPOINT script treats "node" as
# the Docker Swarm subcommand (`docker node ls/promote/...`), not our
# Node.js binary — it rewrote this into `docker node server.js` and
# crash-looped on Swarm's own usage text instead of ever starting the
# HTTP server. Clearing ENTRYPOINT makes Docker exec CMD directly.
ENTRYPOINT []
CMD ["node", "server.js"]

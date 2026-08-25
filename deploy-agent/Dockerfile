# Alpine-based Docker CLI image — deliberately not a Node base image: this
# service's whole job is talking to the host's Docker daemon and running
# git, both easiest to get pre-built on the official docker CLI image.
# nodejs is added on top just to run the small HTTP server.
FROM docker:26-cli

RUN apk add --no-cache nodejs git docker-cli-compose

WORKDIR /app
COPY server.js ./

EXPOSE 8082
CMD ["node", "server.js"]

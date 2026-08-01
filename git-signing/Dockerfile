# syntax=docker/dockerfile:1
ARG NODE_TAG=24-alpine

# --- build: needs the dev toolchain the runtime stage does not ---------------
FROM node:${NODE_TAG} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime -----------------------------------------------------------------
FROM node:${NODE_TAG} AS runtime
# su-exec is the non-obvious one: entrypoint.sh uses it to drop to the workspace
# owner's uid, so objects written into .git are not left root-owned for the anvil.
RUN apk add --no-cache git gnupg su-exec
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV PORT=8080
ENV GIT_SIGNING_WORKSPACE=/workspace
EXPOSE 8080

# The launcher wraps this with a /bin/sh prologue that reads the secret FIFO and
# execs it, so the signing key is already in the environment by the time it runs.
CMD ["/app/entrypoint.sh"]

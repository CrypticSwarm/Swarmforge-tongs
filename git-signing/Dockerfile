# Both stages pin the same node:24-alpine index by digest, so a published image
# is built from exactly what was reviewed; Dependabot proposes the bumps.

# --- build: needs the dev toolchain the runtime stage does not ---------------
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime -----------------------------------------------------------------
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
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

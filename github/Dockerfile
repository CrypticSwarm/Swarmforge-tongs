# Both stages pin the same node:24-alpine index by digest, so a published image
# is built from exactly what was reviewed; Dependabot proposes the bumps.

# The build stage runs on the builder's own platform: its output is plain
# JavaScript, so only the runtime stage has to be built per target platform.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
# su-exec drops to the workspace owner's uid in entrypoint.sh.
RUN apk add --no-cache git su-exec
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY entrypoint.sh askpass.sh /app/
RUN chmod +x /app/entrypoint.sh /app/askpass.sh

ENV PORT=8080
ENV GITHUB_TONG_WORKSPACE=/workspace
EXPOSE 8080

# The launcher wraps this with a /bin/sh prologue that reads the secret FIFO.
CMD ["/app/entrypoint.sh"]

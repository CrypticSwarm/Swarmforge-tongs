# syntax=docker/dockerfile:1
ARG NODE_TAG=24-alpine

FROM node:${NODE_TAG} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:${NODE_TAG} AS runtime
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

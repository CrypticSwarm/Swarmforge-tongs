# Keep both FROM digests identical.

# Build output is plain JavaScript, so only the runtime stage is built per target platform.
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runtime
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

CMD ["/app/entrypoint.sh"]

# Keep both FROM digests identical.

# Build output is plain JavaScript, so only the runtime stage is built per target platform.
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS runtime
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

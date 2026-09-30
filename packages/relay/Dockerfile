# ZCode 手机远控 relay（用户自托管）。
#   docker build -t zcode-relay packages/relay
#   docker run -p 8443:8443 -v <web-dist>:/mobile:ro zcode-relay
FROM node:24-slim AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/relay/package.json packages/relay/
COPY packages/shared/package.json packages/shared/
RUN corepack enable && pnpm install --frozen-lockfile --filter @zcode/relay...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/relay packages/relay
RUN pnpm --filter @zcode/relay build

FROM node:24-slim
WORKDIR /app
COPY --from=build /repo/packages/relay/dist/cli.mjs /app/cli.mjs
EXPOSE 8443
CMD ["node", "/app/cli.mjs"]

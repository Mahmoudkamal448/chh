# chh sync server. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t chh-server .

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @chh/server...
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @chh/server build \
 && node -e "const p=require('./apps/server/package.json');delete p.dependencies['@chh/shared'];delete p.devDependencies;delete p.scripts;require('fs').writeFileSync('/tmp/package.json',JSON.stringify(p,null,2))"

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /tmp/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /repo/apps/server/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/index.js"]

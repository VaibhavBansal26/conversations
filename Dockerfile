# syntax=docker/dockerfile:1
# Node >= 22.13 is required for the built-in node:sqlite module without flags; 24 is what we develop on.
FROM node:24-slim AS build
WORKDIR /app
COPY server/package.json server/package-lock.json server/
COPY web/package.json web/package-lock.json web/
RUN npm ci --prefix server && npm ci --prefix web
COPY server server
COPY web web
RUN npm run build --prefix server && npm run build --prefix web && npm prune --omit=dev --prefix server

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    DATABASE_PATH=/data/conversations.db \
    WEB_DIST=/app/web/dist
WORKDIR /app
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/public server/public
COPY --from=build /app/web/dist web/dist
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]

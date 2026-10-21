FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN npm ci --workspaces --include-workspace-root --no-audit --no-fund || npm install --no-audit --no-fund
COPY packages packages
COPY apps apps
RUN useradd -m caixa && mkdir -p /data && chown caixa /data
USER caixa
ENV DATA_DIR=/data WEB_DIR=/app/apps/web
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm","run","start","-w","@caixa/api"]
